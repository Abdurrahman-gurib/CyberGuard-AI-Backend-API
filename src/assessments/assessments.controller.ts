import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as crypto from 'crypto';
import {
  ActionItem,
  Assessment,
  EvidenceDocument,
  Report,
  Risk,
  RiskVersion,
} from '../entities';
import { CurrentUser, JwtUser } from '../auth/auth';
import { TenancyService } from '../organisations/organisations.controller';

const ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx',
  csv: 'csv',
  txt: 'txt',
  md: 'txt',
};
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB upload policy (FR04)

async function extractText(sourceType: string, buffer: Buffer): Promise<string> {
  if (sourceType === 'pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }
  if (sourceType === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  // csv / txt / md — treat as UTF-8 text
  return buffer.toString('utf8');
}

@Controller()
export class AssessmentsController {
  constructor(
    @InjectRepository(Assessment) private readonly assessments: Repository<Assessment>,
    @InjectRepository(EvidenceDocument) private readonly evidence: Repository<EvidenceDocument>,
    @InjectRepository(Risk) private readonly risks: Repository<Risk>,
    @InjectRepository(RiskVersion) private readonly versions: Repository<RiskVersion>,
    @InjectRepository(ActionItem) private readonly actions: Repository<ActionItem>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    private readonly tenancy: TenancyService,
  ) {}

  /** Loads an assessment and verifies tenant access for the current user. */
  async assertAssessment(id: string, userId: string): Promise<Assessment> {
    const assessment = await this.assessments.findOneBy({ id });
    if (!assessment) throw new NotFoundException('Assessment not found');
    await this.tenancy.assertOrg(assessment.organisationId, userId);
    return assessment;
  }

  @Get('organisations/:orgId/assessments')
  async list(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    return this.assessments.find({ where: { organisationId: orgId }, order: { createdAt: 'DESC' } });
  }

  @Post('organisations/:orgId/assessments')
  async create(
    @CurrentUser() user: JwtUser,
    @Param('orgId') orgId: string,
    @Body() body: { title?: string; horizonMonths?: number },
  ) {
    await this.tenancy.assertOrg(orgId, user.sub);
    const title = (body.title || '').trim();
    if (!title) throw new BadRequestException('Assessment title is required');
    const horizon = Number(body.horizonMonths) || 12;
    return this.assessments.save(
      this.assessments.create({ organisationId: orgId, title, horizonMonths: horizon }),
    );
  }

  @Get('assessments/:id')
  async get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.assertAssessment(id, user.sub);
  }

  // ---- Evidence (FR04) -------------------------------------------------------

  @Get('assessments/:id/evidence')
  async listEvidence(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    await this.assertAssessment(id, user.sub);
    const docs = await this.evidence.find({ where: { assessmentId: id }, order: { uploadedAt: 'DESC' } });
    return docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      sourceType: d.sourceType,
      extractionStatus: d.extractionStatus,
      evidenceStatus: d.evidenceStatus,
      textPreview: (d.extractedText || '').slice(0, 400),
      uploadedAt: d.uploadedAt,
    }));
  }

  @Post('assessments/:id/evidence')
  @UseInterceptors(FileInterceptor('file'))
  async uploadEvidence(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const assessment = await this.assertAssessment(id, user.sub);
    if (!file) throw new BadRequestException('A file is required (multipart field "file")');
    if (file.size > MAX_FILE_BYTES) throw new BadRequestException('File exceeds the 10 MB limit');

    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    const sourceType = ALLOWED_EXTENSIONS[ext];
    if (!sourceType) {
      throw new BadRequestException('Unsupported file type. Allowed: PDF, DOCX, CSV, TXT');
    }

    const doc = this.evidence.create({
      organisationId: assessment.organisationId,
      assessmentId: id,
      filename: file.originalname,
      sourceType,
      contentHash: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    });

    try {
      const text = (await extractText(sourceType, file.buffer)).trim();
      doc.extractedText = text.slice(0, 200_000);
      doc.extractionStatus = text ? 'extracted' : 'failed';
      doc.evidenceStatus = text ? 'documented' : 'awaiting_review';
    } catch (err: any) {
      // Extraction failures are surfaced, never presented as a complete assessment.
      doc.extractionStatus = 'failed';
      doc.evidenceStatus = 'awaiting_review';
      doc.extractedText = null;
    }

    const saved = await this.evidence.save(doc);
    return {
      id: saved.id,
      filename: saved.filename,
      sourceType: saved.sourceType,
      extractionStatus: saved.extractionStatus,
      evidenceStatus: saved.evidenceStatus,
      textPreview: (saved.extractedText || '').slice(0, 400),
      uploadedAt: saved.uploadedAt,
    };
  }

  @Post('evidence/:id/status')
  async setEvidenceStatus(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { evidenceStatus?: string },
  ) {
    const doc = await this.evidence.findOneBy({ id });
    if (!doc) throw new NotFoundException('Evidence document not found');
    await this.tenancy.assertOrg(doc.organisationId, user.sub);
    const allowed = ['reported', 'documented', 'verified', 'outdated', 'awaiting_review'];
    if (!allowed.includes(body.evidenceStatus)) {
      throw new BadRequestException(`evidenceStatus must be one of: ${allowed.join(', ')}`);
    }
    doc.evidenceStatus = body.evidenceStatus;
    return this.evidence.save(doc);
  }

  // ---- Reports (FR12) --------------------------------------------------------

  @Post('assessments/:id/reports')
  async generateReport(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const assessment = await this.assertAssessment(id, user.sub);

    const assessmentRisks = await this.risks.find({ where: { assessmentId: id } });
    const riskIds = assessmentRisks.map((r) => r.id);
    const allVersions = riskIds.length
      ? await this.versions.find({ where: { riskId: In(riskIds) }, order: { versionNo: 'ASC' } })
      : [];
    const latestApproved = new Map<string, RiskVersion>();
    for (const v of allVersions) if (v.status === 'approved') latestApproved.set(v.riskId, v);

    const risksByBand: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const v of latestApproved.values()) if (v.band) risksByBand[v.band]++;

    const orgActions = await this.actions.find({
      where: { organisationId: assessment.organisationId },
    });
    const actionsByStatus: Record<string, number> = {};
    for (const a of orgActions) actionsByStatus[a.status] = (actionsByStatus[a.status] || 0) + 1;

    // Numerical counts come from deterministic queries (dissertation §4.5);
    // the snapshot freezes exact risk-version references for reproducibility.
    const snapshot = {
      generatedAt: new Date().toISOString(),
      assessmentTitle: assessment.title,
      horizonMonths: assessment.horizonMonths,
      totals: { risksByBand, actionsByStatus },
      risks: assessmentRisks.map((r) => {
        const v = latestApproved.get(r.id) || null;
        return {
          riskId: r.id,
          title: r.title,
          latestApprovedVersion: v
            ? {
                versionId: v.id,
                versionNo: v.versionNo,
                likelihood: v.likelihood,
                impact: v.impact,
                score: v.score,
                band: v.band,
                consequenceReview: v.consequenceReview,
                approvedAt: v.approvedAt,
              }
            : null,
        };
      }),
    };

    return this.reports.save(
      this.reports.create({
        organisationId: assessment.organisationId,
        assessmentId: id,
        requestedBy: user.sub,
        snapshot,
      }),
    );
  }

  @Get('assessments/:id/reports')
  async listReports(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    await this.assertAssessment(id, user.sub);
    return this.reports.find({ where: { assessmentId: id }, order: { createdAt: 'DESC' } });
  }
}
