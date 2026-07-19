import { Module } from "@nestjs/common";
import { NuportWebhookController } from "./nuport-webhook.controller";
import { NuportWebhookService } from "./nuport-webhook.service";

@Module({
  controllers: [NuportWebhookController],
  providers: [NuportWebhookService],
})
export class WebhooksModule {}
