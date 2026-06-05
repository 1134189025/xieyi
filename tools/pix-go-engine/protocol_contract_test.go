package main

import (
	"io"
	"net/url"
	"strings"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/bandwidth"
	"golang.org/x/net/proxy"
)

type fakeStripeHTTPClient struct {
	confirmCalled bool
	confirmBody   string
}

func (client *fakeStripeHTTPClient) Do(request *fhttp.Request) (*fhttp.Response, error) {
	body := "{}"
	if strings.HasSuffix(request.URL.Path, "/init") {
		body = `{"init_checksum":"checksum_123","currency":"brl","amount_due":1999}`
	}
	if strings.HasSuffix(request.URL.Path, "/confirm") {
		client.confirmCalled = true
		raw, _ := io.ReadAll(request.Body)
		client.confirmBody = string(raw)
		body = `{"setup_intent":{"id":"seti_123","next_action":{"pix_display_qr_code":{"data":"000201payload"}}}}`
	}
	return &fhttp.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     fhttp.Header{},
	}, nil
}

func TestStripePixConfirmDoesNotRejectNonZeroAmountBeforeConfirm(t *testing.T) {
	httpClient := &fakeStripeHTTPClient{}
	session := &StripeSession{
		ext:  httpClient,
		csID: "cs_test_123",
		logf: func(string, ...any) {},
	}

	confirmData, amount, amountPresent, currency, err := session.stripePixConfirm("pm_123")

	if err != nil {
		t.Fatalf("expected confirm to run before amount eligibility check, got error: %v", err)
	}
	if !httpClient.confirmCalled {
		t.Fatal("expected confirm request to be sent")
	}
	if !strings.Contains(httpClient.confirmBody, "expected_amount=1999") {
		t.Fatalf("expected confirm body to use actual amount, got %q", httpClient.confirmBody)
	}
	if amount != 1999 || !amountPresent || currency != "brl" {
		t.Fatalf("unexpected amount result amount=%d present=%v currency=%q", amount, amountPresent, currency)
	}
	if result := extractPixResult(confirmData); !result.HasQR() {
		t.Fatalf("expected confirm response to contain QR artifact: %+v", confirmData)
	}
}

func (client *fakeStripeHTTPClient) GetCookies(*url.URL) []*fhttp.Cookie  { return nil }
func (client *fakeStripeHTTPClient) SetCookies(*url.URL, []*fhttp.Cookie) {}
func (client *fakeStripeHTTPClient) SetCookieJar(fhttp.CookieJar)         {}
func (client *fakeStripeHTTPClient) GetCookieJar() fhttp.CookieJar        { return nil }
func (client *fakeStripeHTTPClient) SetProxy(string) error                { return nil }
func (client *fakeStripeHTTPClient) GetProxy() string                     { return "" }
func (client *fakeStripeHTTPClient) SetFollowRedirect(bool)               {}
func (client *fakeStripeHTTPClient) GetFollowRedirect() bool              { return false }
func (client *fakeStripeHTTPClient) CloseIdleConnections()                {}
func (client *fakeStripeHTTPClient) Get(string) (*fhttp.Response, error)  { return nil, nil }
func (client *fakeStripeHTTPClient) Head(string) (*fhttp.Response, error) { return nil, nil }
func (client *fakeStripeHTTPClient) Post(string, string, io.Reader) (*fhttp.Response, error) {
	return nil, nil
}
func (client *fakeStripeHTTPClient) GetBandwidthTracker() bandwidth.BandwidthTracker { return nil }
func (client *fakeStripeHTTPClient) GetDialer() proxy.ContextDialer                  { return nil }
func (client *fakeStripeHTTPClient) GetTLSDialer() tlsclient.TLSDialerFunc {
	return nil
}
