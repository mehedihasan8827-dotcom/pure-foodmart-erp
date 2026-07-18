import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";

/**
 * Module map grows batch by batch (blueprint §18.3):
 *  B4 → webhooks (Nuport receiver), orders
 *  B5 → settlements
 *  B6 → expenses, purchases, equity, assets, close
 *  B7 → auth
 */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
