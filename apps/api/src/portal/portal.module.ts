import { Module } from "@nestjs/common";
import {
  AssetsController,
  CloseController,
  EquityController,
  ExpensesController,
  PurchasesController,
  StockCountsController,
  UsersController,
} from "./portal.controllers";

@Module({
  controllers: [
    ExpensesController,
    PurchasesController,
    EquityController,
    AssetsController,
    StockCountsController,
    CloseController,
    UsersController,
  ],
})
export class PortalModule {}
