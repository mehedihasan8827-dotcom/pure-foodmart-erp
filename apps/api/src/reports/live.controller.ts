import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { SessionPrincipal } from "@pfm/auth";
import pg from "pg";
import type { Pool } from "pg";
import { AuthGuard } from "../auth/auth.guard";
import { PG_POOL } from "../db/database.module";

interface SseClient {
  write: (chunk: string) => void;
}

/**
 * The ledger's own heartbeat, fanned out (blueprint §12.1 step 5-6):
 * postEntry NOTIFYs 'pfm_ledger' on commit; one dedicated LISTEN
 * connection here broadcasts to that tenant's connected dashboards over
 * SSE. EventSource can't set headers, so the tenant comes as a query
 * param and membership is verified against the session principal.
 */
@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private listener: pg.Client | null = null;
  private readonly subscribers = new Map<number, Set<SseClient>>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp";
    this.listener = new pg.Client({ connectionString });
    await this.listener.connect();
    await this.listener.query("LISTEN pfm_ledger");
    this.listener.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        const { tenantId, entryNo } = JSON.parse(msg.payload) as {
          tenantId: number;
          entryNo: number;
        };
        const subs = this.subscribers.get(tenantId);
        if (!subs) return;
        const frame = `event: ledger\ndata: ${JSON.stringify({ entryNo })}\n\n`;
        for (const client of subs) client.write(frame);
      } catch {
        /* malformed payload — ignore */
      }
    });
  }

  subscribe(tenantId: number, client: SseClient): () => void {
    const set = this.subscribers.get(tenantId) ?? new Set<SseClient>();
    set.add(client);
    this.subscribers.set(tenantId, set);
    return () => {
      set.delete(client);
      if (set.size === 0) this.subscribers.delete(tenantId);
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.listener?.end();
  }
}

@Controller("portal/live")
@UseGuards(AuthGuard)
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get()
  stream(
    @Req() req: { auth: SessionPrincipal; on: (ev: string, cb: () => void) => void },
    @Res() res: {
      setHeader: (k: string, v: string) => void;
      write: (chunk: string) => void;
      flushHeaders?: () => void;
    },
    @Query("tenantId") tenantIdRaw?: string,
  ): void {
    const tenantId = Number(tenantIdRaw);
    const principal = req.auth;
    const member = principal.memberships.find(
      (m) => m.tenantId === tenantId && m.tenantStatus === "ACTIVE",
    );
    if (!member && !principal.isSuperAdmin) {
      throw new ForbiddenException("No access to this tenant");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: hello\ndata: {"tenantId":${tenantId}}\n\n`);

    const unsubscribe = this.live.subscribe(tenantId, res);
    const heartbeat = setInterval(() => res.write(":keepalive\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
