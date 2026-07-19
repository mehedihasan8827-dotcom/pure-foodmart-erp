import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AuthController } from "./auth.controller";

@Module({
  controllers: [AuthController, AdminController],
})
export class AuthModule {}
