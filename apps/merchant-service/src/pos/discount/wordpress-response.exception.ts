import { HttpException } from '@nestjs/common';

/** Marks a WordPress REST error whose body and status must pass through byte-for-shape unchanged. */
export class WordPressResponseException extends HttpException {
  readonly preserveResponseBody = true;

  constructor(response: unknown, status: number) {
    super(response as string | Record<string, unknown>, status);
  }
}
