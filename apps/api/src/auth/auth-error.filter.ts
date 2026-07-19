import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { AuthError } from "@pfm/auth";

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_CREDENTIALS: 401,
  TOTP_REQUIRED: 401,
  SESSION_INVALID: 401,
  INVALID_TOTP: 403,
  TOTP_NOT_ENABLED: 403,
  USER_EXISTS: 409,
  VALIDATION: 400,
};

/** AuthError → proper HTTP status with the machine-readable code. */
@Catch(AuthError)
export class AuthErrorFilter implements ExceptionFilter {
  catch(exception: AuthError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const status = STATUS_BY_CODE[exception.code] ?? 400;
    res.status(status).json({
      statusCode: status,
      code: exception.code,
      message: exception.message,
    });
  }
}
