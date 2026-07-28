export interface ActivityEntry {
	id: string;
	type: "api" | "fetch";
	startTime: number;
	endTime?: number;
	query?: string;
	url?: string;
	status: number | null;
	error?: string;
}

export class ActivityMonitor {
	private entries: ActivityEntry[] = [];
	private readonly maxEntries = 20;
	private listeners = new Set<() => void>();
	private nextId = 1;
	private visible = false;

	isVisible(): boolean {
		return this.visible;
	}

	toggleVisible(): boolean {
		this.visible = !this.visible;
		this.notify();
		return this.visible;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.notify();
	}

	logStart(partial: Omit<ActivityEntry, "id" | "startTime" | "status">): string {
		const id = `act-${this.nextId++}`;
		this.entries.push({ ...partial, id, startTime: Date.now(), status: null });
		if (this.entries.length > this.maxEntries) this.entries.shift();
		this.notify();
		return id;
	}

	logComplete(id: string, status: number): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) return;
		entry.endTime = Date.now();
		entry.status = status;
		this.notify();
	}

	logError(id: string, error: string): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) return;
		entry.endTime = Date.now();
		entry.error = error;
		this.notify();
	}

	getEntries(): readonly ActivityEntry[] {
		return this.entries;
	}

	formatLines(): string[] {
		const lines = ["─── Web Activity ────────────────────────────────────"];
		if (this.entries.length === 0) {
			lines.push(" (no recent activity)");
		} else {
			for (const e of this.entries) {
				const dur = e.endTime ? `${((e.endTime - e.startTime) / 1000).toFixed(1)}s` : "...";
				const ok = e.error ? "✗" : e.status === null ? "…" : e.status >= 200 && e.status < 400 ? "✓" : "✗";
				const label = e.type === "api" ? `API ${JSON.stringify(e.query ?? "")}` : `GET ${e.url ?? ""}`;
				const status = e.error ? e.error.slice(0, 40) : e.status === null ? "pending" : String(e.status);
				lines.push(` ${label}  ${status}  ${dur} ${ok}`);
			}
		}
		lines.push("────────────────────────────────────────────────────");
		return lines;
	}

	onUpdate(callback: () => void): () => void {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	clear(): void {
		this.entries = [];
		this.notify();
	}

	private notify(): void {
		for (const cb of this.listeners) {
			try {
				cb();
			} catch {
				// ignore listener errors
			}
		}
	}
}

export const activityMonitor = new ActivityMonitor();
