import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  ActionItem,
  Alert,
  EvidenceDocument,
  Risk,
  RiskVersion,
} from '../entities';
import { CurrentUser, JwtUser } from '../auth/auth';
import { TenancyService } from '../organisations/organisations.controller';

// Alert rules are deterministic and never depend on model availability
// (dissertation §5.6). Deduplication: one active alert per (org, dedupKey);
// repeated evaluation must not create duplicate alert rows (T10).

@Controller()
export class AlertsController {
  constructor(
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    @InjectRepository(ActionItem) private readonly actions: Repository<ActionItem>,
    @InjectRepository(Risk) private readonly risks: Repository<Risk>,
    @InjectRepository(RiskVersion) private readonly versions: Repository<RiskVersion>,
    @InjectRepository(EvidenceDocument) private readonly evidence: Repository<EvidenceDocument>,
    private readonly tenancy: TenancyService,
  ) {}

  @Get('organisations/:orgId/alerts')
  async list(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    return this.alerts.find({ where: { organisationId: orgId }, order: { createdAt: 'DESC' } });
  }

  @Post('organisations/:orgId/alerts/evaluate')
  async evaluate(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    const candidates: Array<Pick<Alert, 'severity' | 'message' | 'source' | 'dedupKey'>> = [];
    const now = Date.now();

    // Rule: action overdue (stored deadline + action state).
    const orgActions = await this.actions.find({ where: { organisationId: orgId } });
    for (const a of orgActions) {
      if (a.dueAt && new Date(a.dueAt).getTime() < now && a.status !== 'verified') {
        candidates.push({
          severity: 'high',
          message: `Action "${a.title}" is overdue (due ${a.dueAt.slice(0, 10)}).`,
          source: 'overdue_action',
          dedupKey: `overdue_action:${a.id}`,
        });
      }
    }

    // Rule: approved urgent (high/critical) risk without any linked action.
    const orgRisks = await this.risks.find({ where: { organisationId: orgId } });
    const riskIds = orgRisks.map((r) => r.id);
    const allVersions = riskIds.length
      ? await this.versions.find({ where: { riskId: In(riskIds) }, order: { versionNo: 'ASC' } })
      : [];
    const latestApproved = new Map<string, RiskVersion>();
    for (const v of allVersions) if (v.status === 'approved') latestApproved.set(v.riskId, v);
    const activeActionCount = orgActions.filter((a) => a.status !== 'verified').length;
    for (const [riskId, v] of latestApproved) {
      const risk = orgRisks.find((r) => r.id === riskId);
      if ((v.band === 'high' || v.band === 'critical') && activeActionCount === 0) {
        candidates.push({
          severity: v.band === 'critical' ? 'critical' : 'high',
          message: `Approved ${v.band} risk "${risk?.title}" has no active treatment action.`,
          source: 'urgent_risk',
          dedupKey: `urgent_risk:${riskId}:v${v.versionNo}`,
        });
      }
      // Rule R02: impact 5 requires management consequence review.
      if (v.consequenceReview) {
        candidates.push({
          severity: 'high',
          message: `Risk "${risk?.title}" has impact 5 — management consequence review required.`,
          source: 'consequence_review',
          dedupKey: `consequence_review:${riskId}:v${v.versionNo}`,
        });
      }
    }

    // Rule: evidence awaiting review.
    const pendingEvidence = await this.evidence.find({
      where: { organisationId: orgId, evidenceStatus: 'awaiting_review' },
    });
    for (const doc of pendingEvidence) {
      candidates.push({
        severity: 'medium',
        message: `Evidence "${doc.filename}" is awaiting review (extraction: ${doc.extractionStatus}).`,
        source: 'evidence_review',
        dedupKey: `evidence_review:${doc.id}`,
      });
    }

    // Deduplicate against existing non-resolved alerts.
    const existing = await this.alerts.find({ where: { organisationId: orgId } });
    const activeKeys = new Set(existing.filter((a) => a.state !== 'resolved').map((a) => a.dedupKey));
    const created: Alert[] = [];
    for (const c of candidates) {
      if (activeKeys.has(c.dedupKey)) continue;
      activeKeys.add(c.dedupKey);
      created.push(await this.alerts.save(this.alerts.create({ organisationId: orgId, ...c })));
    }
    return created;
  }

  @Post('alerts/:id/acknowledge')
  async acknowledge(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const alert = await this.alerts.findOneBy({ id });
    if (!alert) throw new NotFoundException('Alert not found');
    await this.tenancy.assertOrg(alert.organisationId, user.sub);
    // Acknowledgement means someone has seen the condition; it does not
    // imply the underlying risk was treated (§5.6).
    if (alert.state === 'open') alert.state = 'acknowledged';
    return this.alerts.save(alert);
  }
}
