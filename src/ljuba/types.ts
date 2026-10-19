export interface LjubaLaunchOptions {
  viewport?: { width: number; height: number };
}

export interface LjubaScreenshotOptions {
  path?: string;
  fullPage?: boolean;
}

export interface LjubaLocatorOptions {
  hasText?: string;
  timeout?: number;
}
