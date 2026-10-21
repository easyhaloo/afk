export declare const BUILD_STAMP_FILE: string;
export declare function sourceFiles(packageDirectory: string): string[];
export declare function buildSources(packageDirectory: string): Record<string, string>;
export declare function writeBuildStamp(packageDirectory: string): void;
