package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type fakePixSession struct {
	result *PixResult
	err    error
}

func (s *fakePixSession) ExtractPixQR(PixBillingBR, bool) (*PixResult, error) {
	return s.result, s.err
}

func TestExecutePixReturnsZeroAmountQRCode(t *testing.T) {
	request := validEngineRequest()
	response := executePix(request, func(GPTToken, string, logFunc) (pixSession, error) {
		return &fakePixSession{result: &PixResult{
			CheckoutSessionID: "cs_test_123",
			PaymentMethodID:   "pm_123",
			PaymentIntentID:   "pi_123",
			Amount:            0,
			AmountPresent:     true,
			Currency:          "brl",
			QRData:            "000201payload",
		}}, nil
	}, &bytes.Buffer{})

	if !response.OK {
		t.Fatalf("expected ok response, got %+v", response.Error)
	}
	if response.Amount != 0 || !response.AmountPresent {
		t.Fatalf("expected explicit zero amount, got amount=%d present=%v", response.Amount, response.AmountPresent)
	}
	if response.QRData != "000201payload" {
		t.Fatalf("unexpected qr data: %q", response.QRData)
	}
}

func TestExecutePixFailsClosedWhenAmountMissing(t *testing.T) {
	response := executePix(validEngineRequest(), func(GPTToken, string, logFunc) (pixSession, error) {
		return &fakePixSession{result: &PixResult{
			CheckoutSessionID: "cs_test_123",
			PaymentMethodID:   "pm_123",
			Amount:            0,
			AmountPresent:     false,
			Currency:          "brl",
			QRData:            "000201payload",
		}}, nil
	}, &bytes.Buffer{})

	if response.OK {
		t.Fatal("expected missing amount to fail")
	}
	if response.Error.Code != "PAYMENT_FAILED" || response.Error.Stage != "engine_io" || response.Error.Detail != "amount_missing" {
		t.Fatalf("unexpected error: %+v", response.Error)
	}
}

func TestExecutePixFailsAccountNotEligibleForNonZeroAmount(t *testing.T) {
	response := executePix(validEngineRequest(), func(GPTToken, string, logFunc) (pixSession, error) {
		return &fakePixSession{result: &PixResult{
			CheckoutSessionID: "cs_test_123",
			PaymentMethodID:   "pm_123",
			Amount:            1999,
			AmountPresent:     true,
			Currency:          "brl",
			QRData:            "000201payload",
		}}, nil
	}, &bytes.Buffer{})

	if response.OK {
		t.Fatal("expected non-zero amount to fail")
	}
	if response.Error.Code != "ACCOUNT_NOT_ELIGIBLE" || response.Error.Stage != "stripe_init" || response.Error.Detail != "amount_nonzero" {
		t.Fatalf("unexpected error: %+v", response.Error)
	}
}

func TestExecutePixRetriesApproveBlocked(t *testing.T) {
	attempts := 0
	response := executePix(validEngineRequest(), func(GPTToken, string, logFunc) (pixSession, error) {
		attempts++
		if attempts < 3 {
			return &fakePixSession{err: &EngineError{Code: "PAYMENT_FAILED", Stage: "chatgpt_approve", Detail: "approve_blocked", StatusCode: 502}}, nil
		}
		return &fakePixSession{result: &PixResult{
			CheckoutSessionID: "cs_test_123",
			PaymentMethodID:   "pm_123",
			Amount:            0,
			AmountPresent:     true,
			Currency:          "brl",
			QRData:            "000201payload",
		}}, nil
	}, &bytes.Buffer{})

	if !response.OK {
		t.Fatalf("expected retry success, got %+v", response.Error)
	}
	if attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts)
	}
}

func TestDeepExtractPixAcceptsNestedQRCodeFields(t *testing.T) {
	payload := map[string]any{
		"nested": []any{
			map[string]any{
				"setup_intent": map[string]any{
					"id":            "seti_123",
					"client_secret": "seti_123_secret_456",
					"next_action": map[string]any{
						"pix_display_qr_code": map[string]any{
							"payload":            "000201payload",
							"png_url":            "https://stripe.test/pix.png",
							"hosted_voucher_url": "https://stripe.test/voucher",
							"expires_at":         float64(1781111404),
						},
					},
				},
			},
		},
	}

	result := extractPixResult(payload)
	if !result.HasQR() {
		t.Fatal("expected qr result")
	}
	if result.QRData != "000201payload" || result.ImageURLPNG == "" || result.HostedInstructionsURL == "" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestWriteJSONRedactsSensitiveLogText(t *testing.T) {
	var out bytes.Buffer
	response := engineResponse{OK: false, Error: engineErrorPayload{
		Code:       "PAYMENT_FAILED",
		StatusCode: 502,
		Stage:      "engine_io",
		Detail:     "token=eyJabc.def.ghi proxy=http://user:secret@host:1000 pix=000201abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
	}}

	if err := writeJSON(&out, response); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "secret") || strings.Contains(out.String(), "eyJabc.def.ghi") {
		t.Fatalf("sensitive data was not redacted: %s", out.String())
	}
}

func TestMainRejectsInvalidJSON(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run(bytes.NewBufferString("{bad-json"), &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected invalid input to fail")
	}
	var response engineResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.OK || response.Error.Stage != "engine_io" || response.Error.Detail != "invalid_input" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestExecutePixMapsFactoryFailure(t *testing.T) {
	response := executePix(validEngineRequest(), func(GPTToken, string, logFunc) (pixSession, error) {
		return nil, errors.New("factory failed")
	}, &bytes.Buffer{})

	if response.OK {
		t.Fatal("expected factory failure")
	}
	if response.Error.Stage != "engine_io" || response.Error.Detail != "session_create_failed" {
		t.Fatalf("unexpected response: %+v", response.Error)
	}
}

func validEngineRequest() engineRequest {
	return engineRequest{
		Token: engineToken{
			AccessToken:  "access-token",
			SessionToken: "session-token",
			DeviceID:     "device-123",
			Email:        "customer@example.com",
		},
		ProxyURL:                 "http://user:pass@br-proxy.example:10001",
		UseTrial:                 true,
		MaxApproveBlockedRetries: 3,
		Billing: PixBillingBR{
			CPF:          "123.456.789-09",
			Email:        "customer@example.com",
			FullName:     "Cliente Teste",
			AddressLine1: "Rua Teste 123",
			City:         "Sao Paulo",
			State:        "SP",
			PostalCode:   "01000-000",
			Country:      "BR",
		},
	}
}
