import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module";
import { HealthController } from "./health/health.controller";
import { PortalModule } from "./portal/portal.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

/**
 * Module map grows batch by batch (blueprint §18.3):
 *  B7 → auth (replaces the dev X-Tenant-Id guard in PortalModule)
 */
@Module({
  imports: [DatabaseModule, WebhooksModule, PortalModule],
  controllers: [HealthController],
})
export class AppModule {}
