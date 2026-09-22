import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  ActionItem,
  Alert,
  Asset,
  Assessment,
  EvidenceDocument,
  Organisation,
  Risk,
  RiskVersion,
} from '../entities';
import { CurrentUser, JwtUser } from '../auth/auth';

@Injectable()
export class TenancyService {
  constructor(
    @InjectRepository(Organisation) private readonly orgs: Repository<Organisation>,
  ) {}

  /** Ensures the organisation exists and belongs to the authenticated user. */
  async assertOrg(orgId: string, userId: string): Promise<Organisation> {
    const org = await this.orgs.findOneBy({ id: orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    if (org.ownerUserId !== userId) throw new ForbiddenException('Not a member of this organisation');
    return org;
  }
}

@Controller('organisations')
export class OrganisationsController {
  constructor(
    @InjectRepository(Organisation) private readonly orgs: Repository<Organisation>,
    @InjectRepository(Asset) private readonly assets: Repository<Asset>,
    @InjectRepository(Assessment) private readonly assessments: Repository<Assessment>,
    @InjectRepository(Risk) private readonly risks: Repository<Risk>,
    @InjectRepository(RiskVersion) private readonly versions: Repository<RiskVersion>,
    @InjectRepository(ActionItem) private readonly actions: Repository<ActionItem>,
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    @InjectRepository(EvidenceDocument) private readonly evidence: Repository<EvidenceDocument>,
    private readonly tenancy: TenancyService,
  ) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.orgs.find({ where: { ownerUserId: user.sub }, order: { createdAt: 'ASC' } });
  }

  @Post()
  create(@CurrentUser() user: JwtUser, @Body() body: { name?: string; sector?: string; size?: string }) {
    const name = (body.name || '').trim();
    if (!name) throw new BadRequestException('Organisation name is required');
    const size = ['small', 'medium', 'large'].includes(body.size) ? body.size : 'small';
    return this.orgs.save(
      this.orgs.create({ name, sector: body.sector || null, size, ownerUserId: user.sub }),
    );
  }

  // ---- Assets ---------------------------------------------------------------

  @Get(':orgId/assets')
  async listAssets(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    return this.assets.find({ where: { organisationId: orgId }, order: { createdAt: 'DESC' } });
  }

  @Post(':orgId/assets')
  async createAsset(
    @CurrentUser() user: JwtUser,
    @Param('orgId') orgId: string,
    @Body() body: { name?: string; assetType?: string; criticality?: number; product?: string; version?: string },
  ) {
    await this.tenancy.assertOrg(orgId, user.sub);
    const name = (body.name || '').trim();
    if (!name) throw new BadRequestException('Asset name is required');
    const criticality = Number(body.criticality);
    if (!Number.isInteger(criticality) || criticality < 1 || criticality > 5) {
      throw new BadRequestException('Criticality must be an integer between 1 and 5');
    }
    return this.assets.save(
      this.assets.create({
        organisationId: orgId,
        name,
        assetType: body.assetType || 'service',
        criticality,
        product: body.product || null,
        version: body.version || null,
      }),
    );
  }

  // ---- Dashboard --------------------------------------------------------------

  @Get(':orgId/dashboard')
  async dashboard(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);

    const orgRisks = await this.risks.find({ where: { organisationId: orgId } });
    const riskIds = orgRisks.map((r) => r.id);
    const allVersions = riskIds.length
      ? await this.versions.find({ where: { riskId: In(riskIds) }, order: { versionNo: 'ASC' } })
      : [];

    // Latest approved version per risk drives the matrix and urgency counts.
    const latestApproved = new Map<string, RiskVersion>();
    for (const v of allVersions) {
      if (v.status === 'approved') latestApproved.set(v.riskId, v);
    }

    const matrixCounts = new Map<string, number>();
    let urgentOpenRisks = 0;
    for (const v of latestApproved.values()) {
      const key = `${v.likelihood}:${v.impact}`;
      matrixCounts.set(key, (matrixCounts.get(key) || 0) + 1);
      if (v.band === 'high' || v.band === 'critical') urgentOpenRisks++;
    }
    const riskMatrix = [...matrixCounts.entries()].map(([key, count]) => {
      const [likelihood, impact] = key.split(':').map(Number);
      return { likelihood, impact, count };
    });

    const orgActions = await this.actions.find({ where: { organisationId: orgId } });
    const now = Date.now();
    const overdueActions = orgActions.filter(
      (a) => a.dueAt && new Date(a.dueAt).getTime() < now && !['verified'].includes(a.status),
    ).length;

    const evidenceAwaitingReview = await this.evidence.count({
      where: { organisationId: orgId, evidenceStatus: 'awaiting_review' },
    });
    const openAlerts = await this.alerts.count({ where: { organisationId: orgId, state: 'open' } });

    const priorityActions = orgActions
      .filter((a) => a.status !== 'verified')
      .sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999'))
      .slice(0, 5)
      .map((a) => ({ id: a.id, title: a.title, status: a.status, dueAt: a.dueAt }));

    const recentAlerts = await this.alerts.find({
      where: { organisationId: orgId },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    return {
      urgentOpenRisks,
      overdueActions,
      evidenceAwaitingReview,
      openAlerts,
      riskMatrix,
      priorityActions,
      recentAlerts,
    };
  }
}
