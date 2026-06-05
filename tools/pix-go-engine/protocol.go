package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"github.com/google/uuid"
)

const (
	stripePK = "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n"
	chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)

type GPTToken struct {
	AccessToken  string
	SessionToken string
	DeviceID     string
	Email        string
}

type PixBillingBR struct {
	CPF          string `json:"cpf"`
	Email        string `json:"email,omitempty"`
	FullName     string `json:"full_name"`
	AddressLine1 string `json:"address_line1"`
	AddressLine2 string `json:"address_line2,omitempty"`
	City         string `json:"city"`
	State        string `json:"state"`
	PostalCode   string `json:"postal_code"`
	Country      string `json:"country"`
}

type PixResult struct {
	CheckoutSessionID       string
	PaymentMethodID         string
	PaymentIntentID         string
	Amount                  int
	AmountPresent           bool
	Currency                string
	QRData                  string
	ImageURLPNG             string
	ImageURLSVG             string
	HostedInstructionsURL   string
	ExpiresAt               int64
	SetupIntentID           string
	SetupIntentClientSecret string
	SetupIntentStatus       string
}

type StripeSession struct {
	cs       tlsclient.HttpClient
	ext      tlsclient.HttpClient
	gptToken GPTToken
	logf     logFunc
	csID     string
	deviceID string
}

func NewStripeSession(proxy string, token GPTToken, logger logFunc) (*StripeSession, error) {
	if logger == nil {
		logger = func(string, ...any) {}
	}
	deviceID := token.DeviceID
	if deviceID == "" {
		deviceID = uuid.NewString()
	}

	logger("[stripe] proxy_enabled=%t", strings.TrimSpace(proxy) != "")
	logger("[stripe] token info: access_token=%t session_cookie=%t device_id=%t email=%t",
		token.AccessToken != "", token.SessionToken != "", token.DeviceID != "", token.Email != "")

	cs, err := newTLSSession(proxy)
	if err != nil {
		return nil, err
	}
	ext, err := newTLSSession(proxy)
	if err != nil {
		return nil, err
	}

	session := &StripeSession{
		cs:       cs,
		ext:      ext,
		gptToken: token,
		logf:     logger,
		deviceID: deviceID,
	}
	session.seedCookies()
	return session, nil
}

func newTLSSession(proxy string) (tlsclient.HttpClient, error) {
	options := []tlsclient.HttpClientOption{
		tlsclient.WithClientProfile(profiles.Chrome_146),
		tlsclient.WithTimeoutSeconds(90),
		tlsclient.WithCookieJar(tlsclient.NewCookieJar()),
		tlsclient.WithNotFollowRedirects(),
	}
	if strings.TrimSpace(proxy) != "" {
		options = append(options, tlsclient.WithProxyUrl(proxy))
	}
	return tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), options...)
}

func (s *StripeSession) seedCookies() {
	chatGPTURL, _ := url.Parse("https://chatgpt.com")
	var cookies []*fhttp.Cookie
	if s.gptToken.SessionToken != "" {
		cookies = append(cookies, &fhttp.Cookie{Name: "__Secure-next-auth.session-token", Value: s.gptToken.SessionToken, Domain: "chatgpt.com", Path: "/"})
	}
	if s.deviceID != "" {
		cookies = append(cookies, &fhttp.Cookie{Name: "oai-did", Value: s.deviceID, Domain: "chatgpt.com", Path: "/"})
	}
	if len(cookies) > 0 {
		s.cs.SetCookies(chatGPTURL, cookies)
	}
}

func (s *StripeSession) ExtractPixQR(billing PixBillingBR, useTrial bool) (*PixResult, error) {
	if err := validatePixBillingBR(billing); err != nil {
		return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "engine_io", Detail: "billing_invalid", Cause: err}
	}

	s.logf("[pix] Step 1: warmup")
	_ = s.warmup()

	s.logf("[pix] Step 2: create BRL/BR checkout")
	if err := s.createCheckoutPixBR(useTrial); err != nil {
		return nil, err
	}

	s.logf("[pix] Step 3: create Pix payment method")
	paymentMethodID, err := s.createPixPaymentMethod(billing)
	if err != nil {
		return nil, err
	}

	s.logf("[pix] Step 4: stripe pix confirm")
	confirmData, amount, amountPresent, currency, err := s.stripePixConfirm(paymentMethodID)
	if err != nil {
		return nil, err
	}
	if result := extractPixResult(confirmData); result.HasQR() {
		result.CheckoutSessionID = s.csID
		result.PaymentMethodID = paymentMethodID
		result.Amount = amount
		result.AmountPresent = amountPresent
		result.Currency = currency
		return result, nil
	}

	s.logf("[pix] Step 5: chatgpt approve")
	approveStatus, approveBody, err := s.chatgptApproveRaw()
	approveResult := ""
	if err != nil {
		s.logf("[pix] chatgpt approve transport failed, continue polling")
	} else if approveStatus >= 400 {
		s.logf("[pix] chatgpt approve status=%d", approveStatus)
	} else {
		var approveData map[string]any
		if json.Unmarshal(approveBody, &approveData) == nil {
			approveResult = strVal(approveData, "result")
			s.logf("[pix] chatgpt approve result=%s", approveResult)
			if result := extractPixResult(approveData); result.HasQR() {
				result.CheckoutSessionID = s.csID
				result.PaymentMethodID = paymentMethodID
				result.Amount = amount
				result.AmountPresent = amountPresent
				result.Currency = currency
				return result, nil
			}
		}
	}

	if amount == 0 {
		switch approveResult {
		case "approved":
			s.logf("[pix] zero amount approve=approved, continue polling")
		case "blocked":
			return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "chatgpt_approve", Detail: "approve_blocked", HTTPStatus: approveStatus}
		default:
			return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "chatgpt_approve", Detail: "approve_not_approved", HTTPStatus: approveStatus}
		}
	}

	s.logf("[pix] Step 6: poll for Pix QR")
	result, err := s.pollForPixQR(paymentMethodID)
	if err != nil {
		return nil, err
	}
	result.CheckoutSessionID = s.csID
	result.PaymentMethodID = paymentMethodID
	result.Amount = amount
	result.AmountPresent = amountPresent
	result.Currency = currency
	return result, nil
}

func (s *StripeSession) warmup() error {
	headers := map[string]string{
		"accept":          "application/json",
		"accept-language": "en-US,en;q=0.9",
		"user-agent":      chromeUA,
	}
	s.cs.SetFollowRedirect(true)
	status, body, err := s.doReq(s.cs, "GET", "https://chatgpt.com/api/auth/session", "", headers)
	if err != nil {
		return err
	}
	if status == 200 {
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil {
			if token, ok := payload["accessToken"].(string); ok && token != "" {
				s.gptToken.AccessToken = token
				s.logf("[stripe] warmup refreshed access token")
			}
		}
		return nil
	}
	s.logf("[stripe] warmup status=%d, continue with original token", status)
	return nil
}

func (s *StripeSession) createCheckoutPixBR(useTrial bool) error {
	request := map[string]any{
		"entry_point": "all_plans_pricing_modal",
		"plan_name":   "chatgptplusplan",
		"billing_details": map[string]any{
			"country":  "BR",
			"currency": "BRL",
		},
		"checkout_ui_mode": "hosted",
		"cancel_url":       "https://chatgpt.com/#pricing",
	}
	if useTrial {
		request["promo_campaign"] = map[string]any{
			"promo_campaign_id":          "plus-1-month-free",
			"is_coupon_from_query_param": false,
		}
	}
	raw, _ := json.Marshal(request)
	s.cs.SetFollowRedirect(true)
	status, body, err := s.doReq(s.cs, "POST", "https://chatgpt.com/backend-api/payments/checkout", string(raw), s.chatgptHeaders())
	if err != nil {
		return &EngineError{Code: "CHATGPT_CHECKOUT_FAILED", StatusCode: 502, Stage: "chatgpt_checkout", Detail: "transport_error", Cause: err}
	}
	if status >= 400 {
		return &EngineError{Code: "CHATGPT_CHECKOUT_FAILED", StatusCode: 502, Stage: "chatgpt_checkout", Detail: "http_error", HTTPStatus: status}
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return &EngineError{Code: "CHATGPT_CHECKOUT_FAILED", StatusCode: 502, Stage: "chatgpt_checkout", Detail: "invalid_json", HTTPStatus: status}
	}
	s.csID = firstNonEmpty(strVal(payload, "checkout_session_id"), strVal(payload, "session_id"), strVal(payload, "id"))
	if !strings.HasPrefix(s.csID, "cs_") {
		return &EngineError{Code: "CHATGPT_CHECKOUT_FAILED", StatusCode: 502, Stage: "chatgpt_checkout", Detail: "missing_checkout_session", HTTPStatus: status}
	}
	return nil
}

func (s *StripeSession) createPixPaymentMethod(billing PixBillingBR) (string, error) {
	country := strings.TrimSpace(billing.Country)
	if country == "" {
		country = "BR"
	}
	email := strings.TrimSpace(billing.Email)
	if email == "" {
		email = strings.TrimSpace(s.gptToken.Email)
	}
	if email == "" {
		email = emailFromJWT(s.gptToken.AccessToken)
	}
	if email == "" {
		return "", &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_payment_method", Detail: "missing_email"}
	}

	form := urlEncode(map[string]string{
		"type":                                  "pix",
		"billing_details[name]":                 billing.FullName,
		"billing_details[email]":                email,
		"billing_details[tax_id]":               billing.CPF,
		"billing_details[address][country]":     country,
		"billing_details[address][line1]":       billing.AddressLine1,
		"billing_details[address][line2]":       billing.AddressLine2,
		"billing_details[address][city]":        billing.City,
		"billing_details[address][state]":       billing.State,
		"billing_details[address][postal_code]": billing.PostalCode,
		"guid":                                  uuid.NewString(),
		"muid":                                  uuid.NewString(),
		"sid":                                   uuid.NewString(),
		"_stripe_version":                       "2020-08-27;custom_checkout_beta=v1",
		"key":                                   stripePK,
		"payment_user_agent":                    "stripe.js/922d612e68; stripe-js-v3/922d612e68; checkout",
		"client_attribution_metadata[client_session_id]":             uuid.NewString(),
		"client_attribution_metadata[checkout_session_id]":           s.csID,
		"client_attribution_metadata[merchant_integration_source]":   "checkout",
		"client_attribution_metadata[merchant_integration_version]":  "hosted_checkout",
		"client_attribution_metadata[payment_method_selection_flow]": "automatic",
		"client_attribution_metadata[checkout_config_id]":            "30777f36-1141-46bc-a435-f4bec3472ed5",
	})
	headers := stripePostHeaders()
	status, body, err := s.doReq(s.ext, "POST", "https://api.stripe.com/v1/payment_methods", form, headers)
	if err != nil {
		return "", &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_payment_method", Detail: "transport_error", Cause: err}
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_payment_method", Detail: "invalid_json", HTTPStatus: status}
	}
	if status != 200 {
		return "", &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_payment_method", Detail: "http_error", HTTPStatus: status}
	}
	paymentMethodID := strVal(payload, "id")
	if !strings.HasPrefix(paymentMethodID, "pm_") {
		return "", &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_payment_method", Detail: "missing_payment_method", HTTPStatus: status}
	}
	return paymentMethodID, nil
}

func (s *StripeSession) stripePixConfirm(paymentMethodID string) (map[string]any, int, bool, string, error) {
	initData, err := s.stripeInit()
	if err != nil {
		return nil, 0, false, "", err
	}
	initChecksum := strVal(initData, "init_checksum")
	currency := strVal(initData, "currency")
	amount, amountPresent := extractAmountFromInit(initData)
	s.logf("[pix] init: currency=%s amount=%d amount_present=%t init_checksum=%s", currency, amount, amountPresent, truncate(initChecksum, 20))

	returnURL := checkoutURL(s.csID)
	form := urlEncode(map[string]string{
		"eid":                          "NA",
		"payment_method":               paymentMethodID,
		"expected_amount":              fmt.Sprintf("%d", amount),
		"consent[terms_of_service]":    "accepted",
		"expected_payment_method_type": "pix",
		"return_url":                   returnURL,
		"_stripe_version":              "2020-08-27;custom_checkout_beta=v1",
		"guid":                         uuid.NewString() + uuid.NewString()[:8],
		"muid":                         uuid.NewString() + uuid.NewString()[:8],
		"sid":                          uuid.NewString() + uuid.NewString()[:8],
		"key":                          stripePK,
		"version":                      "922d612e68",
		"init_checksum":                initChecksum,
		"client_attribution_metadata[client_session_id]":             uuid.NewString(),
		"client_attribution_metadata[checkout_session_id]":           s.csID,
		"client_attribution_metadata[merchant_integration_source]":   "checkout",
		"client_attribution_metadata[merchant_integration_version]":  "hosted_checkout",
		"client_attribution_metadata[payment_method_selection_flow]": "automatic",
		"client_attribution_metadata[checkout_config_id]":            "30777f36-1141-46bc-a435-f4bec3472ed5",
	})
	status, body, err := s.doReq(s.ext, "POST", "https://api.stripe.com/v1/payment_pages/"+s.csID+"/confirm", form, stripePostHeaders())
	if err != nil {
		return nil, amount, amountPresent, currency, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_confirm", Detail: "transport_error", Cause: err}
	}
	if status != 200 {
		return nil, amount, amountPresent, currency, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_confirm", Detail: "http_error", HTTPStatus: status}
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, amount, amountPresent, currency, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_confirm", Detail: "invalid_json", HTTPStatus: status}
	}
	return payload, amount, amountPresent, currency, nil
}

func (s *StripeSession) stripeInit() (map[string]any, error) {
	form := urlEncode(map[string]string{
		"browser_locale":                                   "pt-BR",
		"browser_timezone":                                 "America/Sao_Paulo",
		"elements_session_client[client_betas][0]":         "custom_checkout_server_updates_1",
		"elements_session_client[client_betas][1]":         "custom_checkout_manual_approval_1",
		"elements_session_client[elements_init_source]":    "custom_checkout",
		"elements_session_client[referrer_host]":           "chatgpt.com",
		"elements_session_client[stripe_js_id]":            uuid.NewString(),
		"elements_session_client[locale]":                  "pt-BR",
		"elements_session_client[is_aggregation_expected]": "false",
		"key": stripePK,
	})
	headers := map[string]string{
		"content-type":    "application/x-www-form-urlencoded",
		"user-agent":      chromeUA,
		"accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
	}
	status, body, err := s.doReq(s.ext, "POST", "https://api.stripe.com/v1/payment_pages/"+s.csID+"/init", form, headers)
	if err != nil {
		return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_init", Detail: "transport_error", Cause: err}
	}
	if status != 200 {
		return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_init", Detail: "http_error", HTTPStatus: status}
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_init", Detail: "invalid_json", HTTPStatus: status}
	}
	if strVal(payload, "init_checksum") == "" {
		return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_init", Detail: "missing_init_checksum", HTTPStatus: status}
	}
	return payload, nil
}

func (s *StripeSession) chatgptApproveRaw() (int, []byte, error) {
	body := fmt.Sprintf(`{"checkout_session_id":"%s","processor_entity":"openai_llc"}`, s.csID)
	return s.doReq(s.cs, "POST", "https://chatgpt.com/backend-api/payments/checkout/approve", body, s.chatgptHeaders())
}

func (s *StripeSession) pollForPixQR(paymentMethodID string) (*PixResult, error) {
	params := urlEncode(map[string]string{
		"elements_session_client[client_betas][0]":         "custom_checkout_server_updates_1",
		"elements_session_client[client_betas][1]":         "custom_checkout_manual_approval_1",
		"elements_session_client[elements_init_source]":    "custom_checkout",
		"elements_session_client[referrer_host]":           "chatgpt.com",
		"elements_session_client[stripe_js_id]":            uuid.NewString(),
		"elements_session_client[locale]":                  "pt-BR",
		"elements_session_client[is_aggregation_expected]": "false",
		"key": stripePK,
	})
	headers := map[string]string{
		"user-agent":      chromeUA,
		"accept":          "application/json",
		"accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
	}
	pollURL := "https://api.stripe.com/v1/payment_pages/" + s.csID + "?" + params
	for i := 0; i < 60; i++ {
		time.Sleep(time.Second)
		status, body, err := s.doReq(s.ext, "GET", pollURL, "", headers)
		if err != nil || status != 200 {
			continue
		}
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil {
			continue
		}
		if result := extractPixResult(payload); result.HasQR() {
			result.PaymentMethodID = paymentMethodID
			return result, nil
		}
	}
	return nil, &EngineError{Code: "PAYMENT_FAILED", StatusCode: 502, Stage: "stripe_poll", Detail: "qr_timeout"}
}

func (s *StripeSession) chatgptHeaders() map[string]string {
	return map[string]string{
		"authorization": "Bearer " + s.gptToken.AccessToken,
		"content-type":  "application/json",
		"user-agent":    chromeUA,
	}
}

func stripePostHeaders() map[string]string {
	return map[string]string{
		"content-type":    "application/x-www-form-urlencoded",
		"user-agent":      chromeUA,
		"origin":          "https://pay.openai.com",
		"referer":         "https://pay.openai.com/",
		"accept":          "application/json",
		"accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
	}
}

func (s *StripeSession) doReq(client tlsclient.HttpClient, method, rawURL, body string, headers map[string]string) (int, []byte, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		status, responseBody, err := s.doReqOnce(client, method, rawURL, body, headers)
		if err == nil {
			return status, responseBody, nil
		}
		lastErr = err
		if !isRetryableNetworkError(err) || attempt == 3 {
			return 0, nil, err
		}
		s.logf("[net-retry %d/3] %s %s", attempt, method, hostOnly(rawURL))
	}
	return 0, nil, lastErr
}

func (s *StripeSession) doReqOnce(client tlsclient.HttpClient, method, rawURL, body string, headers map[string]string) (int, []byte, error) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := fhttp.NewRequest(method, rawURL, reader)
	if err != nil {
		return 0, nil, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	return response.StatusCode, responseBody, nil
}

func (result *PixResult) HasQR() bool {
	return result != nil && (result.QRData != "" || result.ImageURLPNG != "" || result.ImageURLSVG != "" || result.HostedInstructionsURL != "")
}

func validatePixBillingBR(billing PixBillingBR) error {
	missing := []string{}
	if strings.TrimSpace(billing.CPF) == "" {
		missing = append(missing, "cpf")
	}
	if strings.TrimSpace(billing.FullName) == "" {
		missing = append(missing, "full_name")
	}
	if strings.TrimSpace(billing.AddressLine1) == "" {
		missing = append(missing, "address_line1")
	}
	if strings.TrimSpace(billing.City) == "" {
		missing = append(missing, "city")
	}
	if strings.TrimSpace(billing.State) == "" {
		missing = append(missing, "state")
	}
	if strings.TrimSpace(billing.PostalCode) == "" {
		missing = append(missing, "postal_code")
	}
	if len(missing) > 0 {
		return fmt.Errorf("billing_br missing fields: %s", strings.Join(missing, ", "))
	}
	return nil
}

func extractPixResult(payload map[string]any) *PixResult {
	result := &PixResult{}
	deepExtractPix(payload, result)
	return result
}

func deepExtractPix(value any, result *PixResult) {
	switch node := value.(type) {
	case map[string]any:
		if id := strVal(node, "id"); strings.HasPrefix(id, "pi_") && result.PaymentIntentID == "" {
			result.PaymentIntentID = id
		}
		if id := strVal(node, "id"); strings.HasPrefix(id, "seti_") && result.SetupIntentID == "" {
			result.SetupIntentID = id
		}
		if paymentIntentID := strVal(node, "payment_intent"); strings.HasPrefix(paymentIntentID, "pi_") && result.PaymentIntentID == "" {
			result.PaymentIntentID = paymentIntentID
		}
		if paymentMethodID := strVal(node, "payment_method"); strings.HasPrefix(paymentMethodID, "pm_") && result.PaymentMethodID == "" {
			result.PaymentMethodID = paymentMethodID
		}
		if clientSecret := strVal(node, "client_secret"); strings.Contains(clientSecret, "_secret_") && result.SetupIntentClientSecret == "" {
			result.SetupIntentClientSecret = clientSecret
		}
		if status := strVal(node, "status"); status != "" && result.SetupIntentStatus == "" {
			result.SetupIntentStatus = status
		}
		if qr, ok := node["pix_display_qr_code"].(map[string]any); ok {
			mergePixQRNode(qr, result)
		}
		if qr, ok := node["qr_code"].(map[string]any); ok {
			mergePixQRNode(qr, result)
		}
		mergePixQRNode(node, result)
		for _, child := range node {
			deepExtractPix(child, result)
		}
	case []any:
		for _, child := range node {
			deepExtractPix(child, result)
		}
	}
}

func mergePixQRNode(node map[string]any, result *PixResult) {
	if result.QRData == "" {
		result.QRData = firstNonEmpty(strVal(node, "data"), strVal(node, "payload"), strVal(node, "qr_code_data"), strVal(node, "qr_code"))
	}
	if result.ImageURLPNG == "" {
		result.ImageURLPNG = firstNonEmpty(strVal(node, "image_url_png"), strVal(node, "png_url"))
	}
	if result.ImageURLSVG == "" {
		result.ImageURLSVG = firstNonEmpty(strVal(node, "image_url_svg"), strVal(node, "svg_url"))
	}
	if result.HostedInstructionsURL == "" {
		result.HostedInstructionsURL = firstNonEmpty(strVal(node, "hosted_instructions_url"), strVal(node, "hosted_voucher_url"), strVal(node, "instructions_url"))
	}
	if result.ExpiresAt == 0 {
		if value, ok := node["expires_at"].(float64); ok {
			result.ExpiresAt = int64(value)
		}
	}
}

func extractAmountFromInit(data map[string]any) (int, bool) {
	for _, key := range []string{"amount_due", "amount_total", "total_amount_due", "total"} {
		if value, ok := numericAmount(data[key]); ok {
			return value, true
		}
	}
	for _, invoiceKey := range []string{"invoice", "upcoming_invoice"} {
		if invoice, ok := data[invoiceKey].(map[string]any); ok {
			for _, key := range []string{"amount_due", "amount_total", "total"} {
				if value, ok := numericAmount(invoice[key]); ok {
					return value, true
				}
			}
		}
	}
	if summary, ok := data["total_summary"].(map[string]any); ok {
		for _, key := range []string{"due", "total"} {
			if value, ok := numericAmount(summary[key]); ok {
				return value, true
			}
		}
	}
	return 0, false
}

func numericAmount(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case json.Number:
		amount, err := typed.Int64()
		return int(amount), err == nil
	default:
		return 0, false
	}
}

func emailFromJWT(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	if email, _ := claims["email"].(string); email != "" {
		return email
	}
	if profile, ok := claims["https://api.openai.com/profile"].(map[string]any); ok {
		email, _ := profile["email"].(string)
		return email
	}
	return ""
}

func urlEncode(values map[string]string) string {
	params := url.Values{}
	for key, value := range values {
		params.Set(key, value)
	}
	return params.Encode()
}

func strVal(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	if limit <= 0 {
		return ""
	}
	return value[:limit]
}

func hostOnly(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "unknown"
	}
	return parsed.Hostname()
}

func isRetryableNetworkError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "eof") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "broken pipe") ||
		strings.Contains(message, "i/o timeout") ||
		strings.Contains(message, "connection refused")
}
