package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

type logFunc func(string, ...any)

type pixSession interface {
	ExtractPixQR(PixBillingBR, bool) (*PixResult, error)
}

type pixSessionFactory func(GPTToken, string, logFunc) (pixSession, error)

type engineRequest struct {
	Token                    engineToken  `json:"token"`
	ProxyURL                 string       `json:"proxy_url,omitempty"`
	Billing                  PixBillingBR `json:"billing"`
	UseTrial                 bool         `json:"use_trial"`
	MaxApproveBlockedRetries int          `json:"max_approve_blocked_retries,omitempty"`
	RetryWaitMs              int          `json:"retry_wait_ms,omitempty"`
}

type engineToken struct {
	AccessToken  string `json:"access_token"`
	SessionToken string `json:"session_token,omitempty"`
	DeviceID     string `json:"device_id,omitempty"`
	Email        string `json:"email,omitempty"`
}

type engineResponse struct {
	OK                      bool               `json:"ok"`
	Error                   engineErrorPayload `json:"error,omitempty"`
	CheckoutSessionID       string             `json:"checkout_session_id,omitempty"`
	CheckoutURL             string             `json:"checkout_url,omitempty"`
	ProcessorEntity         string             `json:"processor_entity,omitempty"`
	PaymentMethodID         string             `json:"payment_method_id,omitempty"`
	PaymentIntentID         string             `json:"payment_intent_id,omitempty"`
	Amount                  int                `json:"amount,omitempty"`
	AmountPresent           bool               `json:"amount_present,omitempty"`
	Currency                string             `json:"currency,omitempty"`
	QRData                  string             `json:"qr_data,omitempty"`
	ImageURLPNG             string             `json:"image_url_png,omitempty"`
	ImageURLSVG             string             `json:"image_url_svg,omitempty"`
	HostedInstructionsURL   string             `json:"hosted_instructions_url,omitempty"`
	ExpiresAt               int64              `json:"expires_at,omitempty"`
	SetupIntentID           string             `json:"setup_intent_id,omitempty"`
	SetupIntentClientSecret string             `json:"setup_intent_client_secret,omitempty"`
	SetupIntentStatus       string             `json:"setup_intent_status,omitempty"`
}

type engineErrorPayload struct {
	Code       string `json:"code,omitempty"`
	StatusCode int    `json:"status_code,omitempty"`
	Stage      string `json:"stage,omitempty"`
	Detail     string `json:"detail,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

type EngineError struct {
	Code       string
	StatusCode int
	Stage      string
	Detail     string
	HTTPStatus int
	Cause      error
}

func (e *EngineError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s:%s:%s", e.Code, e.Stage, e.Detail)
}

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}

func run(stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	var request engineRequest
	decoder := json.NewDecoder(stdin)
	if err := decoder.Decode(&request); err != nil {
		_ = writeJSON(stdout, errorResponse("PAYMENT_FAILED", 502, "engine_io", "invalid_input", 0))
		return 1
	}

	response := executePix(request, func(token GPTToken, proxyURL string, logger logFunc) (pixSession, error) {
		return NewStripeSession(proxyURL, token, logger)
	}, stderr)
	if err := writeJSON(stdout, response); err != nil {
		fmt.Fprintln(stderr, sanitizeDiagnostic(err.Error()))
		return 1
	}
	if response.OK {
		return 0
	}
	return 1
}

func executePix(request engineRequest, factory pixSessionFactory, logWriter io.Writer) engineResponse {
	if strings.TrimSpace(request.Token.AccessToken) == "" {
		return errorResponse("CHATGPT_SESSION_UNRECOGNIZED", 400, "engine_io", "missing_access_token", 0)
	}

	attempts := 1
	if request.UseTrial && request.MaxApproveBlockedRetries > attempts {
		attempts = request.MaxApproveBlockedRetries
	}
	if attempts < 1 {
		attempts = 1
	}

	token := GPTToken{
		AccessToken:  strings.TrimSpace(request.Token.AccessToken),
		SessionToken: strings.TrimSpace(request.Token.SessionToken),
		DeviceID:     strings.TrimSpace(request.Token.DeviceID),
		Email:        strings.TrimSpace(request.Token.Email),
	}
	logger := func(format string, args ...any) {
		if logWriter == nil {
			return
		}
		fmt.Fprintln(logWriter, sanitizeDiagnostic(fmt.Sprintf(format, args...)))
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if attempts > 1 {
			logger("[pix] trial attempt %d/%d", attempt, attempts)
		}
		session, err := factory(token, request.ProxyURL, logger)
		if err != nil {
			return errorResponse("PAYMENT_FAILED", 502, "engine_io", "session_create_failed", 0)
		}
		result, err := session.ExtractPixQR(request.Billing, request.UseTrial)
		if err == nil {
			return responseFromResult(result)
		}
		lastErr = err
		if !isApproveBlockedError(err) || attempt == attempts {
			break
		}
		if request.RetryWaitMs > 0 {
			time.Sleep(time.Duration(request.RetryWaitMs) * time.Millisecond)
		}
	}

	return responseFromError(lastErr)
}

func responseFromResult(result *PixResult) engineResponse {
	if result == nil {
		return errorResponse("PAYMENT_FAILED", 502, "engine_io", "empty_result", 0)
	}
	if !result.AmountPresent {
		return errorResponse("PAYMENT_FAILED", 502, "engine_io", "amount_missing", 0)
	}
	if result.Amount > 0 {
		return errorResponse("ACCOUNT_NOT_ELIGIBLE", 400, "stripe_init", "amount_nonzero", 200)
	}
	if strings.TrimSpace(result.QRData) == "" {
		return errorResponse("PAYMENT_FAILED", 502, "engine_io", "invalid_success_payload", 0)
	}

	return engineResponse{
		OK:                      true,
		CheckoutSessionID:       result.CheckoutSessionID,
		CheckoutURL:             checkoutURL(result.CheckoutSessionID),
		ProcessorEntity:         "openai_llc",
		PaymentMethodID:         result.PaymentMethodID,
		PaymentIntentID:         result.PaymentIntentID,
		Amount:                  result.Amount,
		AmountPresent:           result.AmountPresent,
		Currency:                result.Currency,
		QRData:                  result.QRData,
		ImageURLPNG:             result.ImageURLPNG,
		ImageURLSVG:             result.ImageURLSVG,
		HostedInstructionsURL:   result.HostedInstructionsURL,
		ExpiresAt:               result.ExpiresAt,
		SetupIntentID:           result.SetupIntentID,
		SetupIntentClientSecret: result.SetupIntentClientSecret,
		SetupIntentStatus:       result.SetupIntentStatus,
	}
}

func responseFromError(err error) engineResponse {
	if err == nil {
		return errorResponse("PAYMENT_FAILED", 502, "engine_io", "unknown_error", 0)
	}
	var engineErr *EngineError
	if errors.As(err, &engineErr) {
		statusCode := engineErr.StatusCode
		if statusCode == 0 {
			statusCode = 502
		}
		code := engineErr.Code
		if code == "" {
			code = "PAYMENT_FAILED"
		}
		return errorResponse(code, statusCode, engineErr.Stage, engineErr.Detail, engineErr.HTTPStatus)
	}
	return errorResponse("PAYMENT_FAILED", 502, "engine_io", "protocol_failed", 0)
}

func errorResponse(code string, statusCode int, stage string, detail string, httpStatus int) engineResponse {
	return engineResponse{
		OK: false,
		Error: engineErrorPayload{
			Code:       code,
			StatusCode: statusCode,
			Stage:      stage,
			Detail:     sanitizeDiagnostic(detail),
			HTTPStatus: httpStatus,
		},
	}
}

func writeJSON(writer io.Writer, response engineResponse) error {
	if !response.OK {
		response.Error.Detail = sanitizeDiagnostic(response.Error.Detail)
	}
	encoder := json.NewEncoder(writer)
	return encoder.Encode(response)
}

func checkoutURL(checkoutSessionID string) string {
	if strings.TrimSpace(checkoutSessionID) == "" {
		return ""
	}
	return "https://checkout.stripe.com/c/pay/" + checkoutSessionID + "?redirect_pm_type=pix&ui_mode=custom"
}

func isApproveBlockedError(err error) bool {
	if err == nil {
		return false
	}
	var engineErr *EngineError
	if errors.As(err, &engineErr) {
		return engineErr.Stage == "chatgpt_approve" && engineErr.Detail == "approve_blocked"
	}
	return strings.Contains(strings.ToLower(err.Error()), "approve_blocked")
}

var jwtPattern = regexp.MustCompile(`eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*`)
var looseJWTStartPattern = regexp.MustCompile(`eyJ[^\s"'<>]+`)
var pixPattern = regexp.MustCompile(`000201[A-Za-z0-9+/.=_-]{40,}`)
var proxyCredentialPattern = regexp.MustCompile(`://([^:@/\s]+):([^@/\s]+)@`)

func sanitizeDiagnostic(value string) string {
	sanitized := jwtPattern.ReplaceAllString(value, "[redacted-token]")
	sanitized = looseJWTStartPattern.ReplaceAllString(sanitized, "[redacted-token]")
	sanitized = pixPattern.ReplaceAllString(sanitized, "[redacted-pix-code]")
	sanitized = proxyCredentialPattern.ReplaceAllString(sanitized, "://****@")
	return strings.TrimSpace(sanitized)
}
