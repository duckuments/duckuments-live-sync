// Tiny in-memory log buffer with live subscription, for the "Show logs" view.
type LogListener = (line: string) => void;

class Logger {
    readonly lines: string[] = [];
    private max = 500;
    private listeners = new Set<LogListener>();

    log(msg: string): void {
        const line = `${new Date().toLocaleTimeString()}  ${msg}`;
        this.lines.push(line);
        if (this.lines.length > this.max) this.lines.shift();
        for (const l of this.listeners) l(line);
    }

    subscribe(l: LogListener): () => void {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }
}

export const logger = new Logger();
