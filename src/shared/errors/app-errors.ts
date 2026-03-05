export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class DomainError extends AppError {
  constructor(message: string, code = "DOMAIN_ERROR") {
    super(message, code, 400);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = "VALIDATION_ERROR") {
    super(message, code, 400);
  }
}

export class AuthError extends AppError {
  constructor(message: string, code = "AUTH_ERROR", statusCode = 401) {
    super(message, code, statusCode);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = "NOT_FOUND") {
    super(message, code, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "CONFLICT") {
    super(message, code, 409);
  }
}
