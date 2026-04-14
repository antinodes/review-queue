const STORAGE_KEY = 'review-queue-gh-token'

export function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}

export function saveToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(STORAGE_KEY)
}
