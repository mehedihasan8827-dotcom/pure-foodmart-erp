import { Module } from "@nestjs/common";
import {
  AssetsController,
  CloseController,
  EquityController,
  ExpensesController,
  PurchasesController,
  StockCountsController,
} from "./portal.controllers";

@Module({
  controllers: [
    ExpensesController,
    PurchasesController,
    EquityController,
    AssetsController,
    StockCountsController,
    CloseController,
  ],
})
export class PortalModule {}
