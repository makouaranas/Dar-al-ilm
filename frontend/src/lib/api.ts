/**
 * Typed client for the local REST API (docs/ARCHITECTURE.md section 6).
 *
 * - Same origin in production; NEXT_PUBLIC_API_BASE (http://127.0.0.1:8000) under `next dev`.
 * - Every mutating request sends `X-Dar-Client: 1` (the backend refuses it otherwise).
 * - Errors become `ApiError` with the backend's `code` (or a client-side code).
 */

export type ReadingDirection = "LTR" | "RTL";
export type UiLanguage = "en" | "ar";
export type GraphicsQuality = "auto" | "performance" | "high";
export type PageQuality = "low" | "high" | "zoom";

export interface Category {
  id: number;
  name: string;
  column_index: number;
  book_count: number;
  created_at: string;
}

export interface Book {
  id: number;
  title: string;
  author: string | null;
  notes: string | null;
  category_id: number;
  reading_direction: ReadingDirection;
  page_count: number;
  page_width_pt: number;
  page_height_pt: number;
  spine_color: string;
  cover_url: string;
  cover_is_custom: boolean;
  file_size_bytes: number;
  file_missing: boolean;
  last_read_page: number;
  last_opened_at: string | null;
  shelf_number: number;
  slot_index: number;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  ui_language: UiLanguage;
  default_direction: ReadingDirection;
  graphics_quality: GraphicsQuality;
  ambient_light: number;
}

export interface Bootstrap {
  categories: Category[];
  books: Book[];
  currently_reading: number[];
  settings: Settings;
  api_version: number;
}

export interface Upload {
  upload_id: string;
  original_filename: string;
  file_size_bytes: number;
  page_count: number;
  page_width_pt: number;
  page_height_pt: number;
  suggested_title: string;
  suggested_direction: ReadingDirection;
  cover_preview_url: string;
  duplicate_of: { id: number; title: string } | null;
  expires_at: string;
}

export interface NewBook {
  uploadId: string;
  title: string;
  categoryId: number;
  readingDirection: ReadingDirection;
  author?: string;
  notes?: string;
  cover?: Blob;
}

export interface BookPatch {
  title?: string;
  author?: string | null;
  notes?: string | null;
  category_id?: number;
  reading_direction?: ReadingDirection;
  last_read_page?: number;
  mark_opened?: boolean;
}

export type SettingsPatch = Partial<Settings>;

/** Error codes from the backend (section 6.1) plus client-side ones. */
export type ApiErrorCode =
  | "forbidden_client"
  | "forbidden_origin"
  | "not_pdf"
  | "file_too_large"
  | "pdf_encrypted"
  | "pdf_empty"
  | "pdf_damaged"
  | "invalid_cover"
  | "upload_not_found"
  | "category_not_found"
  | "category_name_taken"
  | "category_not_empty"
  | "book_not_found"
  | "page_out_of_range"
  | "pdf_missing"
  | "validation_error"
  | "http_error"
  | "network_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");
const CLIENT_HEADER = { "X-Dar-Client": "1" } as const;

/** Absolute URL for an API path (also for <img> and texture URLs such as cover_url). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function errorFromBody(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail) && "code" in detail) {
    const { code, message, ...extra } = detail as { code: ApiErrorCode; message?: string };
    return new ApiError(status, code, message ?? code, extra);
  }
  if (status === 422) return new ApiError(status, "validation_error", "The request is not valid.", { detail });
  return new ApiError(status, "http_error", `Request failed with status ${status}.`);
}

async function request<T>(method: string, path: string, init: { json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = method === "GET" ? {} : { ...CLIENT_HEADER };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method, headers, body, cache: "no-store" });
  } catch {
    throw new ApiError(0, "network_error", "The library service cannot be reached.");
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw errorFromBody(response.status, parsed);
  return parsed as T;
}

// --- Endpoints ------------------------------------------------------------------------

export const getHealth = () => request<{ status: "ok"; api_version: number }>("GET", "/api/health");

export const fetchBootstrap = () => request<Bootstrap>("GET", "/api/bootstrap");

export const createCategory = (name: string) => request<Category>("POST", "/api/categories", { json: { name } });

export const renameCategory = (id: number, name: string) =>
  request<Category>("PATCH", `/api/categories/${id}`, { json: { name } });

export const deleteCategory = (id: number, moveTo?: number) =>
  request<void>("DELETE", `/api/categories/${id}${moveTo === undefined ? "" : `?move_to=${moveTo}`}`);

export const updateSettings = (patch: SettingsPatch) => request<Settings>("PATCH", "/api/settings", { json: patch });

export const cancelUpload = (uploadId: string) => request<void>("DELETE", `/api/uploads/${uploadId}`);

export function createBook(input: NewBook): Promise<Book> {
  const form = new FormData();
  form.set("upload_id", input.uploadId);
  form.set("title", input.title);
  form.set("category_id", String(input.categoryId));
  form.set("reading_direction", input.readingDirection);
  if (input.author) form.set("author", input.author);
  if (input.notes) form.set("notes", input.notes);
  if (input.cover) form.set("cover_file", input.cover, "cover");
  return request<Book>("POST", "/api/books", { form });
}

export const updateBook = (id: number, patch: BookPatch) => request<Book>("PATCH", `/api/books/${id}`, { json: patch });

export const deleteBook = (id: number) => request<void>("DELETE", `/api/books/${id}`);

export function replaceCover(id: number, cover: Blob): Promise<Book> {
  const form = new FormData();
  form.set("cover_file", cover, "cover");
  return request<Book>("PUT", `/api/books/${id}/cover`, { form });
}

export const revertCover = (id: number) => request<Book>("DELETE", `/api/books/${id}/cover`);

export function pageUrl(bookId: number, page: number, quality: PageQuality): string {
  return apiUrl(`/api/books/${bookId}/page/${page}?quality=${quality}`);
}

/**
 * Upload a PDF with progress events (fetch has no upload progress, so this uses XHR).
 * `onProgress` receives 0..1. Abort with the returned controller.
 */
export function uploadPdf(
  file: Blob,
  filename: string,
  onProgress?: (fraction: number) => void,
): { promise: Promise<Upload>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Upload>((resolve, reject) => {
    xhr.open("POST", apiUrl("/api/uploads"));
    xhr.setRequestHeader("X-Dar-Client", "1");
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const parsed: unknown = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      if (xhr.status === 201) resolve(parsed as Upload);
      else reject(errorFromBody(xhr.status, parsed));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", "The library service cannot be reached."));
    xhr.onabort = () => reject(new ApiError(0, "network_error", "The upload was cancelled."));
    const form = new FormData();
    form.set("pdf_file", file, filename);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * Save the reading position while the page is closing (pagehide / visibilitychange).
 * `keepalive` lets the request finish after the page is gone (docs/ARCHITECTURE.md 11.5).
 */
export function saveBookmarkKeepalive(bookId: number, lastReadPage: number): void {
  void fetch(apiUrl(`/api/books/${bookId}`), {
    method: "PATCH",
    headers: { ...CLIENT_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ last_read_page: lastReadPage }),
    keepalive: true,
  }).catch(() => undefined);
}
