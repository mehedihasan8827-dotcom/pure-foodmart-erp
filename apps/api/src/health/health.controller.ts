import { Controller, Get } from "@nestjs/common";

interface HealthReport {
  status: "ok";
  service: string;
  version: string;
  time: string;
}

@Controller("health")
export class HealthController {
  @Get()
  health(): HealthReport {
    return {
      status: "ok",
      service: "pure-foodmart-erp-api",
      version: "0.1.0",
      time: new Date().toISOString(),
    };
  }
}
