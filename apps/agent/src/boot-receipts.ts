import type { IdentityImage } from '@apk/automation';

export function verifiedBootReceipts(value: unknown, sdk: string, images: IdentityImage[]) {
  const receipt = value as {
    version?: unknown;
    sdkRoot?: unknown;
    images?: {
      id: string;
      model: string;
      apiLevel: number;
      sha256: string;
      vendorSha256?: string;
      supportedAbis: string[];
    }[];
  } | null;
  if (
    receipt?.version !== 1 ||
    receipt.sdkRoot !== sdk ||
    !Array.isArray(receipt.images) ||
    images.length !== 33 ||
    receipt.images.length !== images.length ||
    new Set(receipt.images.map((p) => p?.id)).size !== images.length
  )
    throw Error('IDENTITY_PROOF_INVALID');
  const result = new Map<string, string[]>();
  for (const image of images) {
    const actual = receipt.images.find((p) => p?.id === image.id);
    if (
      !actual ||
      actual.model !== image.model ||
      actual.apiLevel !== (image.apiLevel ?? 35) ||
      actual.sha256 !== image.sha256 ||
      actual.vendorSha256 !== image.vendorSha256 ||
      !Array.isArray(actual.supportedAbis) ||
      !actual.supportedAbis.length ||
      actual.supportedAbis.length > 8 ||
      actual.supportedAbis.some((a) => typeof a !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(a)) ||
      new Set(actual.supportedAbis).size !== actual.supportedAbis.length ||
      (image.supportedAbis &&
        [...image.supportedAbis].sort().join(',') !== [...actual.supportedAbis].sort().join(','))
    )
      throw Error('IDENTITY_PROOF_INVALID');
    result.set(image.id, actual.supportedAbis);
  }
  return result;
}
