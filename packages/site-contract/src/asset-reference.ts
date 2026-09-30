export function isValidAssetReference(value: string): boolean {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return false;
  }

  if (trimmedValue.startsWith('/')) {
    return !trimmedValue.includes(' ') && !trimmedValue.includes('..');
  }

  try {
    const parsedUrl = new URL(trimmedValue);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}
