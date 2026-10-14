import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

const DRIVER_FIELDS = [
  'code',
  'detail',
  'hint',
  'schema',
  'table',
  'column',
  'constraint',
  'routine',
] as const;

/**
 * Returns every unhandled failure in Nest's HTTP error shape.
 * Status 500 responses include the thrown message and database driver fields
 * so create and update callers can see the server error that was hidden before.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {
    this.logger.log('Global exception filter is active');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException
      ? this.httpExceptionBody(exception, status)
      : this.serverErrorBody(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(errorMessage(body), stack);
    }

    httpAdapter.reply(context.getResponse(), body, status);
  }

  private httpExceptionBody(exception: HttpException, status: number) {
    if ((exception as HttpException & { preserveResponseBody?: boolean }).preserveResponseBody) {
      return exception.getResponse() as Record<string, unknown>;
    }
    const response = exception.getResponse();
    const error = httpErrorName(status);
    if (typeof response === 'string') {
      return { statusCode: status, message: response, error };
    }
    if (response && typeof response === 'object') {
      const payload = response as Record<string, unknown>;
      return {
        error,
        ...payload,
        statusCode: typeof payload.statusCode === 'number' ? payload.statusCode : status,
      };
    }
    return { statusCode: status, message: exception.message, error };
  }

  private serverErrorBody(exception: unknown) {
    const error = exception instanceof Error ? exception : new Error(this.describe(exception));
    const details = {
      name: error.name || 'Error',
      ...driverFields(exception),
    };
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: error.message || 'Internal server error',
      details,
    };
  }

  private describe(exception: unknown): string {
    if (typeof exception === 'string') return exception;
    try {
      return JSON.stringify(exception);
    } catch {
      return 'Internal server error';
    }
  }
}

function errorMessage(body: { message?: unknown }): string {
  if (typeof body.message === 'string' && body.message) return body.message;
  if (Array.isArray(body.message)) return body.message.map(String).join(', ');
  return 'Internal server error';
}

function httpErrorName(status: number): string {
  const phrase = HttpStatus[status];
  if (typeof phrase !== 'string') return 'Error';
  return phrase
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

function driverFields(exception: unknown): Record<string, string> {
  if (!exception || typeof exception !== 'object') return {};
  const record = exception as Record<string, unknown>;
  const driver = record.driverError && typeof record.driverError === 'object'
    ? record.driverError as Record<string, unknown>
    : record;
  const details: Record<string, string> = {};
  for (const field of DRIVER_FIELDS) {
    const value = driver[field];
    if (typeof value === 'string' && value.trim()) details[field] = value;
  }
  if (typeof record.query === 'string' && record.query.trim()) details.query = record.query;
  return details;
}
