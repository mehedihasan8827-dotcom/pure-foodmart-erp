import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module";
import { HealthController } from "./health/health.controller";
import { WebhooksModule } from "./webhooks/webhooks.module";

/**
 * Module map grows batch by batch (blueprint §18.3):
 *  B5 → settlements
 *  B6 → expenses, purchases, equity, assets, close
 *  B7 → auth
 */
@Module({
  imports: [DatabaseModule, WebhooksModule],
  controllers: [HealthController],
})
export class AppModule {}
