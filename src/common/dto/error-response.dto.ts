export class ErrorResponseDto {
  errorCode: string;
  message: string;
  retryable: boolean;
  transactionId?: string;
  serverTime: string;

  constructor(errorCode: string, message: string, retryable: boolean, transactionId?: string) {
    this.errorCode = errorCode;
    this.message = message;
    this.retryable = retryable;
    this.transactionId = transactionId;
    this.serverTime = new Date().toISOString();
  }
}
