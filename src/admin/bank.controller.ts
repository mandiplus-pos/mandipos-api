import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/validate';
import { AdminGuard, See, mine, type Viewer } from './admin.controller';
import { BankService } from './bank.service';

/**
 * Bank page (owner's list 2.6): per account an opening, the bank ledger, the statement upload
 * (CSV with a column mapping, or lines typed in) and the reconciliation. An owner, a MandiPlus
 * admin, and the shop's partner may use every route here; the partner's writes are exactly the
 * handlers listed in PARTNER_HANDLERS (admin.controller.ts), all of them in this file.
 */
const Day = z.iso.date();
const AccountQuery = z.object({ account: z.string().trim().min(1).max(40), from: Day.optional(), to: Day.optional() });
const signedPaise = z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00);
const paise = z.number().int().positive().max(1_000_000_000_00);
const OpeningBody = z.object({ account: z.string().trim().min(1).max(40), openingPaise: signedPaise, openingOn: Day });
const col = z.number().int().min(0).max(200).optional();
const ImportBody = z.object({
  account: z.string().trim().min(1).max(40),
  text: z.string().min(1).max(8_000_000),
  fileName: z.string().max(120).default(''),
  headerRow: z.number().int().min(-1).max(1000),
  mapping: z.object({ date: z.number().int().min(0).max(200), narration: col, ref: col, debit: col, credit: col, amount: col, drcr: col, balance: col }),
  dateOrder: z.enum(['dmy', 'mdy', 'ymd']).default('dmy'),
});
const PreviewBody = z.object({ text: z.string().min(1).max(8_000_000) });
const LinesBody = z.object({
  account: z.string().trim().min(1).max(40),
  lines: z.array(z.object({
    date: Day, direction: z.enum(['cr', 'dr']), amountPaise: paise, ref: z.string().max(60).optional(), narration: z.string().max(300).optional(),
    balancePaise: signedPaise.nullable().optional(),
  })).min(1).max(500),
});
const MatchBody = z.object({ lineId: z.uuid(), entryKey: z.string().regex(/^(bill|col|dep|chq|chqfee|day):[0-9a-f-]{36}$/, 'entry') });
const Id = z.uuid();

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class BankController {
  constructor(private readonly bank: BankService) {}

  /** The shop's accounts with their openings and how much statement each has. */
  @Get('shops/:id/bank')
  bankAccounts(@See() v: Viewer, @Param('id') id: string) {
    return this.bank.accounts(mine(v, id));
  }

  @Post('shops/:id/bank/opening')
  @HttpCode(200)
  bankSetOpening(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(OpeningBody, body);
    return this.bank.setOpening(mine(v, id), v.phone, b.account, b.openingPaise, b.openingOn);
  }

  @Get('shops/:id/bank/ledger')
  bankLedger(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const q = parse(AccountQuery, query);
    return this.bank.ledger(mine(v, id), q.account, q.from, q.to);
  }

  /** The CSV's header and columns as guessed, for the person to check; nothing is saved. */
  @Post('shops/:id/bank/csv/preview')
  @HttpCode(200)
  bankCsvPreview(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    mine(v, id);
    return this.bank.csvPreview(parse(PreviewBody, body).text);
  }

  @Post('shops/:id/bank/csv/import')
  bankCsvImport(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ImportBody, body);
    return this.bank.csvImport(mine(v, id), v.phone, b.account, b);
  }

  /** Statement lines typed in by hand, when there is no CSV. */
  @Post('shops/:id/bank/lines')
  bankAddLines(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(LinesBody, body);
    return this.bank.addLines(mine(v, id), v.phone, b.account, b.lines);
  }

  @Post('shops/:id/bank/lines/:lid/void')
  @HttpCode(204)
  async bankVoidLine(@See() v: Viewer, @Param('id') id: string, @Param('lid') lid: string) {
    await this.bank.voidLine(mine(v, id), parse(Id, lid));
  }

  @Get('shops/:id/bank/batches')
  bankBatches(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.bank.batches(mine(v, id), parse(AccountQuery, query).account);
  }

  @Post('shops/:id/bank/batches/:bid/void')
  @HttpCode(204)
  async bankVoidBatch(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string) {
    await this.bank.voidBatch(mine(v, id), parse(Id, bid));
  }

  @Get('shops/:id/bank/reconcile')
  bankReconcile(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const q = parse(AccountQuery, query);
    return this.bank.reconcile(mine(v, id), q.account, q.from, q.to);
  }

  @Post('shops/:id/bank/match')
  @HttpCode(204)
  async bankMatch(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(MatchBody, body);
    await this.bank.match(mine(v, id), v.phone, b.lineId, b.entryKey);
  }

  @Post('shops/:id/bank/unmatch')
  @HttpCode(204)
  async bankUnmatch(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(MatchBody, body);
    await this.bank.unmatch(mine(v, id), v.phone, b.lineId, b.entryKey);
  }
}
