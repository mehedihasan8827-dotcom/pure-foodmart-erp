import { Module } from "@nestjs/common";
import { LiveController, LiveService } from "./live.controller";
import { ReportsController } from "./reports.controller";

@Module({
  controllers: [ReportsController, LiveController],
  providers: [LiveService],
})
export class ReportsModule {}
