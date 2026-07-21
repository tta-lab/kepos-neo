export interface BareKitRelease {
  version?: string;
  url?: string;
  size: number;
  sha256: string;
}

export const BARE_KIT: Readonly<Required<BareKitRelease>>;

export function proxyUrlFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string | undefined;

export function verifyArchive(
  archivePath: string,
  expected?: BareKitRelease,
): Promise<void>;

export function ensureArchive(options: {
  archivePath: string;
  expected?: BareKitRelease;
  fetchImpl?: typeof fetch;
  downloadImpl?: (options: {
    url: string;
    partialArchive: string;
  }) => Promise<boolean>;
}): Promise<void>;

export function aria2cArguments(options: {
  url: string;
  partialArchive: string;
  proxyUrl?: string;
}): string[];

export function downloadWithAria2c(options: {
  url: string;
  partialArchive: string;
  proxyUrl?: string;
}): Promise<boolean>;

export function installAndroidPrebuild(options: {
  archivePath: string;
  destination: string;
  extractImpl?: (
    archivePath: string,
    options: { dir: string },
  ) => Promise<void>;
}): Promise<void>;
