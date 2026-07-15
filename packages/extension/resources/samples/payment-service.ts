import { EventEmitter } from 'node:events';
import type { TransactionRepository } from './repositories/transaction-repository.js';
import type { AuthorizationGateway } from './gateways/authorization-gateway.js';
import type { FeeCalculator } from './services/fee-calculator.js';
import type { AuditLogger } from './services/audit-logger.js';

export interface PaymentRequest {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
  amount: number;
  currency: string;
  merchantId: string;
  reference: string;
}

export interface PaymentResult {
  transactionId: string;
  authCode: string | null;
  status: 'approved' | 'declined' | 'error';
  fee: number;
  netAmount: number;
  errorMessage?: string;
}

export class PaymentService extends EventEmitter {
  constructor(
    private readonly transactionRepo: TransactionRepository,
    private readonly authGateway: AuthorizationGateway,
    private readonly feeCalculator: FeeCalculator,
    private readonly auditLogger: AuditLogger,
  ) {
    super();
  }

  async processPayment(request: PaymentRequest): Promise<PaymentResult> {
    const transactionId = this.generateTransactionId();
    await this.auditLogger.log('payment.attempt', {
      transactionId,
      merchantId: request.merchantId,
    });

    const validation = this.validateRequest(request);
    if (!validation.valid) {
      return this.buildErrorResult(transactionId, validation.reason!);
    }

    const fee = this.feeCalculator.calculate(request.amount, request.currency);
    const netAmount = request.amount - fee;

    let authResult: { approved: boolean; authCode?: string; reason?: string };
    try {
      authResult = await this.authGateway.authorize({
        cardNumber: request.cardNumber,
        amount: request.amount,
        currency: request.currency,
        merchantId: request.merchantId,
      });
    } catch (err) {
      await this.auditLogger.log('payment.gateway_error', { transactionId, error: String(err) });
      return this.buildErrorResult(transactionId, 'Gateway unavailable');
    }

    const result: PaymentResult = authResult.approved
      ? { transactionId, authCode: authResult.authCode!, status: 'approved', fee, netAmount }
      : {
          transactionId,
          authCode: null,
          status: 'declined',
          fee: 0,
          netAmount: 0,
          errorMessage: authResult.reason,
        };

    await this.transactionRepo.save({
      id: transactionId,
      ...request,
      ...result,
      timestamp: new Date(),
    });
    await this.auditLogger.log(`payment.${result.status}`, { transactionId });
    this.emit('payment:processed', result);
    return result;
  }

  async refund(transactionId: string, amount: number): Promise<PaymentResult> {
    const original = await this.transactionRepo.findById(transactionId);
    if (!original) return this.buildErrorResult(transactionId, 'Original transaction not found');
    if (amount > original.amount)
      return this.buildErrorResult(transactionId, 'Refund amount exceeds original');

    const refundId = this.generateTransactionId();
    const refundResult = await this.authGateway.refund({
      originalTransactionId: transactionId,
      amount,
    });

    await this.transactionRepo.save({
      id: refundId,
      originalId: transactionId,
      amount,
      status: refundResult.approved ? 'approved' : 'declined',
      timestamp: new Date(),
    });

    this.emit('payment:refunded', { refundId, transactionId, amount });
    return {
      transactionId: refundId,
      authCode: refundResult.authCode ?? null,
      status: refundResult.approved ? 'approved' : 'declined',
      fee: 0,
      netAmount: amount,
    };
  }

  private validateRequest(request: PaymentRequest): { valid: boolean; reason?: string } {
    if (request.amount <= 0) return { valid: false, reason: 'Amount must be positive' };
    if (request.cardNumber.length !== 16) return { valid: false, reason: 'Invalid card number' };
    if (request.currency.length !== 3) return { valid: false, reason: 'Invalid currency code' };
    return { valid: true };
  }

  private buildErrorResult(transactionId: string, errorMessage: string): PaymentResult {
    return { transactionId, authCode: null, status: 'error', fee: 0, netAmount: 0, errorMessage };
  }

  private generateTransactionId(): string {
    return `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }
}
