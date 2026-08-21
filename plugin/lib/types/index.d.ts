/** Node half of dsh-agent-commander — standard cordis Service form. */
import type { Service, Context } from "@deepseek-ai/cordis";

export interface AgentMeta {
	id: string;
	type: string;
	name: string;
	role: string;
	skills: string[];
	cwd: string;
	status: string;
	exited: boolean;
	exitCode: number | null;
	createdAt: number;
	updatedAt: number;
}
export interface MemoryEntry {
	id: number;
	namespace: string;
	title: string;
	body: string;
	tags: string;
	source: string;
	created_at: string;
}

/**
 * Standard cordis service provided as `agentCommander` — other plugins can
 * declare `inject: ['agentCommander']` and use `ctx.agentCommander`.
 */
export declare class AgentCommanderService extends Service {
	readonly registry: unknown;
	readonly memoryStore: unknown;
	readonly config: { maxAgents: number; baseCwd: string; rolePresets: string[] };
	list(): AgentMeta[];
	open(opts: { type: string; name?: string; role?: string; skills?: string[]; cwd?: string; cols?: number; rows?: number }): AgentMeta;
	send(id: string, text: string, submit?: boolean): { id: string };
	read(id: string, bytes?: number): { output: string; truncated: boolean; exited: boolean; status: string; exitCode: number | null };
	approve(id: string, choice?: string): { id: string };
	signal(id: string, signal: string): { id: string };
	close(id: string, graceful?: boolean): { id: string };
	status(id: string): AgentMeta | null;
	memory: {
		query(term: string, limit?: number, cwd?: string): MemoryEntry[];
		add(entry: { namespace?: string; title: string; body: string; tags?: string; source?: string }, cwd?: string): { id: number };
		list(namespace?: string, limit?: number, cwd?: string): MemoryEntry[];
	};
	storeFor(cwd?: string): unknown;
}

export declare const name: "dsh-agent-commander";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: { maxAgents?: number; baseCwd?: string }): AgentCommanderService;
