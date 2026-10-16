/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Unknown API error');
  }
  if (error !== null && error !== undefined) return String(error);
  return 'Unknown API error';
}

/**
 * Appends an error's message to a sentence for a notification.
 *
 * @param text - The sentence.
 * @param error - The thrown value.
 * @returns `<text>: <message>`, or `text` alone when the error has no message.
 */
export function withErrorDetail(text: string, error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message;
  const detail = typeof message === 'string' ? message.trim() : '';
  return detail ? `${text}: ${detail}` : text;
}

export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return (error as { status?: unknown }).status === 404;
}
