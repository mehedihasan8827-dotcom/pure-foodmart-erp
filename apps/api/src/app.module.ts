import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./db/database.module";
import { HealthController } from "./health/health.controller";
import { PortalModule } from "./portal/portal.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [DatabaseModule, AuthModule, WebhooksModule, PortalModule],
  controllers: [HealthController],
})
export class AppModule {}
