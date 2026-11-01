export function startPlatformFlowModel(electron: string): Promise<{
    url: string;
    files: Record<string, string>;
    observations: Array<{
        n?: number;
        scenario?: string;
        model?: string;
        tools?: string[];
        response_tools?: string[];
        has_image?: boolean;
        held?: boolean;
        error?: string;
    }>;
    setScenario(value: string): void;
    setHold(value: boolean): void;
    heldCount(): number;
    cancelled(): number;
    close(): Promise<void>;
}>;
