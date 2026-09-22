import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  Assessment,
  Control,
  Recommendation,
  Risk,
  RiskVersion,
} from '../entities';
import { CurrentUser, JwtUser } from '../auth/auth';
import { TenancyService } from '../organisations/organisations.controller';
import {
  calculateBand,
  calculateScore,
  requiresConsequenceReview,
  validateRating,
} from '../risk-policy';

@Controller()
export class RisksController {
  constructor(
    @InjectRepository(Assessment) private readonly assessments: Repository<Assessment>,
    @InjectRepository(Risk) private readonly risks: Repository<Risk>,
    @InjectRepository(RiskVersion) private readonly versions: Repository<RiskVersion>,
    @InjectRepository(Recommendation) private readonly recommendations: Repository<Recommendation>,
    @InjectRepository(Control) private readonly controls: Repository<Control>,
    private readonly tenancy: TenancyService,
  ) {}

  private async assertRisk(riskId: string, userId: string): Promise<Risk> {
    const risk = await this.risks.findOneBy({ id: riskId });
    if (!risk) throw new NotFoundException('Risk not found');
    await this.tenancy.assertOrg(risk.organisationId, userId);
    return risk;
  }

  @Get('assessments/:id/risks')
  async listForAssessment(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const assessment = await this.assessments.findOneBy({ id });
    if (!assessment) throw new NotFoundException('Assessment not found');
    await this.tenancy.assertOrg(assessment.organisationId, user.sub);

    const list = await this.risks.find({ where: { assessmentId: id }, order: { createdAt: 'DESC' } });
    const riskIds = list.map((r) => r.id);
    const allVersions = riskIds.length
      ? await this.versions.find({ where: { riskId: In(riskIds) }, order: { versionNo: 'ASC' } })
      : [];
    return list.map((r) => ({
      ...r,
      versions: allVersions.filter((v) => v.riskId === r.id),
    }));
  }

  @Post('assessments/:id/risks')
  async createRisk(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { title?: string; description?: string; assetId?: string },
  ) {
    const assessment = await this.assessments.findOneBy({ id });
    if (!assessment) throw new NotFoundException('Assessment not found');
    await this.tenancy.assertOrg(assessment.organisationId, user.sub);
    const title = (body.title || '').trim();
    if (!title) throw new BadRequestException('Risk title is required');
    return this.risks.save(
      this.risks.create({
        organisationId: assessment.organisationId,
        assessmentId: id,
        assetId: body.assetId || null,
        title,
        description: body.description || null,
      }),
    );
  }

  // ---- Versions (FR07): score and band are always recalculated server-side ---

  @Post('risks/:id/versions')
  async createVersion(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { likelihood?: number; impact?: number; basis?: string; rationale?: string },
  ) {
    const risk = await this.assertRisk(id, user.sub);

    let likelihood: number, impact: number;
    try {
      likelihood = validateRating(body.likelihood, 'likelihood');
      impact = validateRating(body.impact, 'impact');
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    const basis = body.basis === 'projected' ? 'projected' : 'current';

    const existing = await this.versions.find({ where: { riskId: risk.id }, order: { versionNo: 'DESC' }, take: 1 });
    const versionNo = existing.length ? existing[0].versionNo + 1 : 1;

    const score = calculateScore(likelihood, impact);
    return this.versions.save(
      this.versions.create({
        riskId: risk.id,
        versionNo,
        likelihood,
        impact,
        score,
        band: calculateBand(score),
        basis,
        rationale: body.rationale || null,
        consequenceReview: requiresConsequenceReview(impact),
      }),
    );
  }

  @Post('risk-versions/:id/approve')
  async approveVersion(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const version = await this.versions.findOneBy({ id });
    if (!version) throw new NotFoundException('Risk version not found');
    const risk = await this.assertRisk(version.riskId, user.sub);
    if (version.status === 'approved') {
      throw new ConflictException('This version is already approved and immutable');
    }
    version.status = 'approved';
    version.approvedBy = user.sub;
    version.approvedAt = new Date().toISOString();
    const saved = await this.versions.save(version);
    if (risk.status !== 'assessed') {
      risk.status = 'assessed';
      await this.risks.save(risk);
    }
    return saved;
  }

  // ---- Risk register ---------------------------------------------------------

  @Get('organisations/:orgId/risk-register')
  async register(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    const orgRisks = await this.risks.find({ where: { organisationId: orgId }, order: { createdAt: 'DESC' } });
    const riskIds = orgRisks.map((r) => r.id);
    const allVersions = riskIds.length
      ? await this.versions.find({ where: { riskId: In(riskIds) }, order: { versionNo: 'ASC' } })
      : [];
    const assessmentsById = new Map(
      (await this.assessments.find({ where: { organisationId: orgId } })).map((a) => [a.id, a.title]),
    );

    return orgRisks.map((r) => {
      const versions = allVersions.filter((v) => v.riskId === r.id);
      const latest = versions.length ? versions[versions.length - 1] : null;
      return {
        riskId: r.id,
        title: r.title,
        assessmentTitle: assessmentsById.get(r.assessmentId) || '',
        latestVersion: latest,
      };
    });
  }

  // ---- Recommendations (FR08) --------------------------------------------------

  @Post('risk-versions/:id/recommendations')
  async recommend(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { controlId?: string; priority?: string; rationale?: string },
  ) {
    const version = await this.versions.findOneBy({ id });
    if (!version) throw new NotFoundException('Risk version not found');
    if (version.status !== 'approved') {
      throw new BadRequestException('Recommendations can only be attached to approved risk versions');
    }
    const risk = await this.assertRisk(version.riskId, user.sub);
    const control = await this.controls.findOneBy({ id: body.controlId });
    if (!control) throw new BadRequestException('Unknown control identifier — only catalogue controls are allowed');
    const priority = ['immediate', 'scheduled', 'longer_term'].includes(body.priority)
      ? body.priority
      : 'scheduled';
    const duplicate = await this.recommendations.findOneBy({ riskVersionId: id, controlId: control.id });
    if (duplicate) throw new ConflictException('This control is already recommended for this risk version');
    return this.recommendations.save(
      this.recommendations.create({
        organisationId: risk.organisationId,
        riskVersionId: id,
        controlId: control.id,
        priority,
        rationale: body.rationale || null,
      }),
    );
  }

  @Get('organisations/:orgId/recommendations')
  async listRecommendations(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    const recs = await this.recommendations.find({ where: { organisationId: orgId }, order: { createdAt: 'DESC' } });
    const controlsById = new Map((await this.controls.find()).map((c) => [c.id, c]));
    const versionIds = recs.map((r) => r.riskVersionId);
    const versions = versionIds.length ? await this.versions.find({ where: { id: In(versionIds) } }) : [];
    const versionById = new Map(versions.map((v) => [v.id, v]));
    const riskIds = [...new Set(versions.map((v) => v.riskId))];
    const risksById = new Map(
      (riskIds.length ? await this.risks.find({ where: { id: In(riskIds) } }) : []).map((r) => [r.id, r]),
    );
    return recs.map((rec) => {
      const version = versionById.get(rec.riskVersionId);
      const risk = version ? risksById.get(version.riskId) : null;
      return {
        id: rec.id,
        priority: rec.priority,
        rationale: rec.rationale,
        status: rec.status,
        control: controlsById.get(rec.controlId) || null,
        riskTitle: risk ? risk.title : '',
      };
    });
  }
}

@Controller('controls')
export class ControlsController {
  constructor(@InjectRepository(Control) private readonly controls: Repository<Control>) {}

  @Get()
  list() {
    return this.controls.find({ order: { controlCode: 'ASC' } });
  }
}
