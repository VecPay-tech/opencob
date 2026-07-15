// Package gateway implements an HTTP payment gateway microservice.
// It accepts payment requests, routes to an upstream authoriser,
// and persists transaction results.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// PaymentRequest is the incoming JSON payload.
type PaymentRequest struct {
	CardNumber string  `json:"cardNumber"`
	ExpiryMM   int     `json:"expiryMonth"`
	ExpiryYY   int     `json:"expiryYear"`
	Amount     float64 `json:"amount"`
	Currency   string  `json:"currency"`
	MerchantID string  `json:"merchantId"`
	Reference  string  `json:"reference"`
}

// PaymentResponse is returned to callers.
type PaymentResponse struct {
	TransactionID string  `json:"transactionId"`
	Status        string  `json:"status"`
	AuthCode      string  `json:"authCode,omitempty"`
	Fee           float64 `json:"fee"`
	NetAmount     float64 `json:"netAmount"`
	ErrorMessage  string  `json:"errorMessage,omitempty"`
}

// Authoriser sends requests upstream and returns an authorisation decision.
type Authoriser interface {
	Authorize(ctx context.Context, req PaymentRequest) (authCode string, approved bool, err error)
}

// Store persists and retrieves transactions.
type Store interface {
	Save(ctx context.Context, tx Transaction) error
	FindByID(ctx context.Context, id string) (*Transaction, error)
}

// Transaction is the persisted payment record.
type Transaction struct {
	ID         string
	MerchantID string
	Amount     float64
	Currency   string
	Fee        float64
	NetAmount  float64
	Status     string
	AuthCode   string
	CreatedAt  time.Time
}

// Gateway routes payment requests through authorisation and persistence.
type Gateway struct {
	auth    Authoriser
	store   Store
	feeRate float64
	logger  *slog.Logger
}

// NewGateway constructs a Gateway with the given dependencies.
func NewGateway(auth Authoriser, store Store, feeRate float64, logger *slog.Logger) *Gateway {
	return &Gateway{auth: auth, store: store, feeRate: feeRate, logger: logger}
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/payments":
		g.handlePayment(w, r)
	case r.Method == http.MethodGet && len(r.URL.Path) > len("/payments/"):
		g.handleGetTransaction(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (g *Gateway) handlePayment(w http.ResponseWriter, r *http.Request) {
	var req PaymentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		g.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := g.validate(req); err != nil {
		g.writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	authCode, approved, err := g.auth.Authorize(r.Context(), req)
	if err != nil {
		g.logger.Error("authorisation failed", "error", err, "merchantId", req.MerchantID)
		g.writeError(w, http.StatusBadGateway, "upstream authoriser unavailable")
		return
	}

	fee := req.Amount * g.feeRate
	tx := Transaction{
		ID:         fmt.Sprintf("TXN-%d", time.Now().UnixNano()),
		MerchantID: req.MerchantID,
		Amount:     req.Amount,
		Currency:   req.Currency,
		Fee:        fee,
		NetAmount:  req.Amount - fee,
		Status:     boolStatus(approved),
		AuthCode:   authCode,
		CreatedAt:  time.Now(),
	}

	if err := g.store.Save(r.Context(), tx); err != nil {
		g.logger.Error("store.Save failed", "error", err)
	}

	g.writeJSON(w, http.StatusOK, PaymentResponse{
		TransactionID: tx.ID, Status: tx.Status, AuthCode: tx.AuthCode,
		Fee: tx.Fee, NetAmount: tx.NetAmount,
	})
}

func (g *Gateway) handleGetTransaction(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/payments/"):]
	tx, err := g.store.FindByID(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		g.writeError(w, http.StatusNotFound, "transaction not found")
		return
	}
	if err != nil {
		g.writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	g.writeJSON(w, http.StatusOK, tx)
}

func (g *Gateway) validate(req PaymentRequest) error {
	if req.Amount <= 0 {
		return errors.New("amount must be positive")
	}
	if len(req.CardNumber) != 16 {
		return errors.New("invalid card number length")
	}
	if len(req.Currency) != 3 {
		return errors.New("invalid currency code")
	}
	return nil
}

func (g *Gateway) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func (g *Gateway) writeError(w http.ResponseWriter, status int, msg string) {
	g.writeJSON(w, status, map[string]string{"error": msg})
}

func boolStatus(approved bool) string {
	if approved {
		return "approved"
	}
	return "declined"
}

// ErrNotFound is returned when a transaction is not found in the store.
var ErrNotFound = errors.New("not found")
