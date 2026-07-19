import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import {
  NuportWebhookService,
  type WebhookReceipt,
} from "./nuport-webhook.service";

/**
 * Minimal envelope check only — full validation happens in the processor
 * (webhooks are triggers, not sources of truth, §2.2). The raw payload is
 * archived verbatim in nuport_events either way.
 */
const envelopeSchema = z
  .object({
    orderRef: z.string().min(1),
    eventId: z.string().min(1).optional(),
  })
  .passthrough();

@Controller("webhooks")
export class NuportWebhookController {
  constructor(private readonly service: NuportWebhookService) {}

  @Post("nuport/:token")
  @HttpCode(200)
  async receive(
    @Param("token") token: string,
    @Body() body: unknown,
  ): Promise<WebhookReceipt> {
    const tenantId = await this.service.resolveTenant(token);
    if (tenantId === null) {
      // Unknown/revoked token: 404, not 401 — don't confirm the URL space.
      throw new NotFoundException();
    }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new NotFoundException(); // malformed probe — same non-answer
    }
    return this.service.receive(
      tenantId,
      parsed.data.orderRef,
      parsed.data.eventId ?? null,
      body,
    );
  }
}
