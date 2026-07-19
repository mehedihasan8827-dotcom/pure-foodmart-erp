import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from "@nestjs/common";
import { InventoryError, NeedsBomError } from "@pfm/inventory";
import { LedgerError } from "@pfm/ledger";
import { PortalError } from "@pfm/portals";

/** Domain validation errors → 400 with the message; everything else → 500. */
@Catch(PortalError, LedgerError, InventoryError, NeedsBomError)
export class PortalErrorFilter implements ExceptionFilter {
  catch(exception: Error, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const body = new BadRequestException(exception.message).getResponse();
    res.status(400).json(body);
  }
}
