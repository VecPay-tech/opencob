package com.paytech.payment;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PaymentProcessor orchestrates authorization, fee calculation,
 * and settlement for card payments.
 */
public class PaymentProcessor {

    private final AuthorizationGateway authGateway;
    private final FeePolicy feePolicy;
    private final TransactionStore transactionStore;
    private final AuditLog auditLog;

    public PaymentProcessor(
            AuthorizationGateway authGateway,
            FeePolicy feePolicy,
            TransactionStore transactionStore,
            AuditLog auditLog) {
        this.authGateway = authGateway;
        this.feePolicy = feePolicy;
        this.transactionStore = transactionStore;
        this.auditLog = auditLog;
    }

    public PaymentResult process(PaymentRequest request) {
        String transactionId = UUID.randomUUID().toString();
        auditLog.record("payment.start", transactionId, request.merchantId());

        ValidationResult validation = validate(request);
        if (!validation.isValid()) {
            return PaymentResult.declined(transactionId, validation.reason());
        }

        BigDecimal fee = feePolicy.calculateFee(request.amount(), request.currency());
        BigDecimal netAmount = request.amount().subtract(fee);

        AuthorizationResponse auth;
        try {
            auth = authGateway.authorize(
                new AuthorizationRequest(
                    request.cardNumber(), request.amount(),
                    request.currency(), request.merchantId()));
        } catch (GatewayException ex) {
            auditLog.record("payment.gateway_error", transactionId, ex.getMessage());
            return PaymentResult.error(transactionId, "Gateway unavailable");
        }

        Transaction tx = Transaction.builder()
                .id(transactionId)
                .merchantId(request.merchantId())
                .amount(request.amount())
                .fee(fee)
                .netAmount(netAmount)
                .status(auth.approved() ? Status.APPROVED : Status.DECLINED)
                .authCode(auth.authCode())
                .timestamp(Instant.now())
                .build();

        transactionStore.save(tx);
        auditLog.record("payment." + tx.status().name().toLowerCase(), transactionId, request.merchantId());

        return auth.approved()
                ? PaymentResult.approved(transactionId, auth.authCode(), fee, netAmount)
                : PaymentResult.declined(transactionId, auth.declineReason());
    }

    public RefundResult refund(String originalTransactionId, BigDecimal amount) {
        Transaction original = transactionStore.findById(originalTransactionId)
                .orElseThrow(() -> new PaymentException(
                    "Transaction not found: " + originalTransactionId));

        if (amount.compareTo(original.amount()) > 0) {
            throw new PaymentException("Refund amount exceeds original transaction amount");
        }

        AuthorizationResponse refundAuth = authGateway.refund(originalTransactionId, amount);

        Transaction refundTx = Transaction.builder()
                .id(UUID.randomUUID().toString())
                .originalId(originalTransactionId)
                .amount(amount)
                .status(refundAuth.approved() ? Status.APPROVED : Status.DECLINED)
                .timestamp(Instant.now())
                .build();

        transactionStore.save(refundTx);
        return new RefundResult(refundTx.id(), refundAuth.approved(), amount);
    }

    public List<Transaction> getDailySettlement(String merchantId, String date) {
        return transactionStore.findByMerchantAndDate(merchantId, date);
    }

    private ValidationResult validate(PaymentRequest request) {
        if (request.amount().compareTo(BigDecimal.ZERO) <= 0)
            return ValidationResult.invalid("Amount must be positive");
        if (request.cardNumber() == null || request.cardNumber().length() != 16)
            return ValidationResult.invalid("Invalid card number");
        if (request.currency() == null || request.currency().length() != 3)
            return ValidationResult.invalid("Invalid currency code");
        return ValidationResult.valid();
    }
}
