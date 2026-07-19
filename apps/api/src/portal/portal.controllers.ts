import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  closePeriod,
  createPartner,
  createSupplier,
  disposeAsset,
  recordCapitalInjection,
  recordCashDrawing,
  recordDrawingInKind,
  recordExpense,
  recordPurchase,
  recordStockCount,
  registerAsset,
  runCloseChecklist,
  runDepreciation,
  unlockPeriod,
} from "@pfm/portals";
import type { Pool } from "pg";
import { z } from "zod";
import { PG_POOL } from "../db/database.module";
import { PortalErrorFilter } from "./portal-error.filter";
import { TenantContextGuard, TenantId } from "./tenant.guard";
import { parseBody } from "./zod";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "money as decimal string");
const qty = z.string().regex(/^\d+(\.\d{1,3})?$/, "qty as decimal string");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.string().regex(/^\d{4}-\d{2}$/);

@Controller("portal/expenses")
@UseGuards(TenantContextGuard)
@UseFilters(PortalErrorFilter)
export class ExpensesController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  @Post()
  create(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({
        expenseDate: date,
        expenseAccountCode: z.string(),
        paidFromAccountCode: z.string(),
        amount: money,
        description: z.string().min(1),
        receiptUrl: z.string().url().optional(),
      }),
      body,
    );
    return recordExpense(this.pool, tenantId, dto);
  }
}

@Controller("portal/purchases")
@UseGuards(TenantContextGuard)
@UseFilters(PortalErrorFilter)
export class PurchasesController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  @Post()
  create(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({
        purchasedOn: date,
        supplierId: z.number().int().positive().optional(),
        invoiceRef: z.string().optional(),
        paidFromAccountCode: z.string().optional(),
        memo: z.string().optional(),
        lines: z
          .array(z.object({ sku: z.string(), qty, unitCost: z.string() }))
          .min(1),
      }),
      body,
    );
    return recordPurchase(this.pool, tenantId, dto);
  }

  @Post("suppliers")
  supplier(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({ name: z.string().min(1), phone: z.string().optional() }),
      body,
    );
    return createSupplier(this.pool, tenantId, dto);
  }
}

@Controller("portal/equity")
@UseGuards(TenantContextGuard)
@UseFilters(PortalErrorFilter)
export class EquityController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post("partners")
  partner(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({
        name: z.string().min(1),
        capitalAccountCode: z.string(),
        drawingsAccountCode: z.string(),
        sharePct: z.string().regex(/^\d+(\.\d{1,3})?$/),
        validFrom: date,
      }),
      body,
    );
    return createPartner(this.pool, tenantId, dto);
  }

  @Post("capital-in")
  capitalIn(@TenantId() tenantId: number, @Body() body: unknown) {
    return recordCapitalInjection(this.pool, tenantId, parseBody(cashTxSchema, body));
  }

  @Post("drawing-cash")
  drawingCash(@TenantId() tenantId: number, @Body() body: unknown) {
    return recordCashDrawing(this.pool, tenantId, parseBody(cashTxSchema, body));
  }

  @Post("drawing-kind")
  drawingKind(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({
        partnerId: z.number().int().positive(),
        txDate: date,
        lines: z.array(z.object({ sku: z.string(), qty })).min(1),
        notes: z.string().optional(),
      }),
      body,
    );
    return recordDrawingInKind(this.pool, tenantId, dto);
  }
}

const cashTxSchema = z.object({
  partnerId: z.number().int().positive(),
  amount: money,
  txDate: date,
  cashAccountCode: z.string(),
  notes: z.string().optional(),
});

@Controller("portal/assets")
@UseGuards(TenantContextGuard)
@UseFilters(PortalErrorFilter)
export class AssetsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post()
  register(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({
        assetCode: z.string().min(1),
        name: z.string().min(1),
        assetAccountCode: z.string(),
        acquiredOn: date,
        cost: money,
        salvageValue: money.optional(),
        method: z.enum(["STRAIGHT_LINE", "DIMINISHING"]),
        lifeMonths: z.number().int().positive().optional(),
        diminishingAnnualRate: z.string().optional(),
        paidFromAccountCode: z.string(),
      }),
      body,
    );
    return registerAsset(this.pool, tenantId, dto);
  }

  @Post("depreciation-run")
  depreciation(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(z.object({ period }), body);
    return runDepreciation(this.pool, tenantId, dto.period);
  }

  @Post(":assetCode/dispose")
  dispose(
    @TenantId() tenantId: number,
    @Param("assetCode") assetCode: string,
    @Body() body: unknown,
  ) {
    const dto = parseBody(
      z.object({
        disposedOn: date,
        salePrice: money,
        proceedsAccountCode: z.string(),
      }),
      body,
    );
    return disposeAsset(this.pool, tenantId, { assetCode, ...dto });
  }
}

@Controller("portal/stock-counts")
@UseGuards(TenantContextGuard)
@UseFilters(PortalErrorFilter)
export class StockCountsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  @Post()
  create(@TenantId() tenantId: number, @Body() body: unknown) {
    const dto = parseBody(
      z.object({
        countedOn: date,
        notes: z.string().optional(),
        lines: z.array(z.object({ sku: z.string(), countedQty: qty })).min(1),
      }),
      body,
    );
    return recordStockCount(this.pool, tenantId, dto);
  }
}

@Controller("portal/close")
@UseGuards(TenantContextGuard)
@UseFilters(PortalErrorFilter)
export class CloseController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get(":period/checklist")
  checklist(@TenantId() tenantId: number, @Param("period") p: string) {
    return runCloseChecklist(this.pool, tenantId, parseBody(period, p));
  }

  @Post(":period")
  close(@TenantId() tenantId: number, @Param("period") p: string) {
    return closePeriod(this.pool, tenantId, parseBody(period, p), null);
  }

  @Post(":period/unlock")
  unlock(
    @TenantId() tenantId: number,
    @Param("period") p: string,
    @Body() body: unknown,
  ) {
    const dto = parseBody(z.object({ reason: z.string().min(3) }), body);
    return unlockPeriod(this.pool, tenantId, parseBody(period, p), null, dto.reason);
  }
}
