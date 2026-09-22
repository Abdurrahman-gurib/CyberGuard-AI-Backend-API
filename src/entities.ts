import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Column types are kept portable between SQLite (local dev) and PostgreSQL
// (production). JSON payloads use 'simple-json'; dates other than created_at
// are stored as ISO strings.

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) email: string;
  @Column() passwordHash: string;
  @Column() displayName: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('organisations')
export class Organisation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column({ nullable: true }) sector: string;
  @Column({ default: 'small' }) size: string;
  @Index() @Column() ownerUserId: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Column() name: string;
  @Column() assetType: string;
  @Column({ type: 'int' }) criticality: number;
  @Column({ nullable: true }) product: string;
  @Column({ nullable: true }) version: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('assessments')
export class Assessment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Column() title: string;
  @Column({ type: 'int', default: 12 }) horizonMonths: number;
  @Column({ default: 'draft' }) status: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('evidence_documents')
export class EvidenceDocument {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Index() @Column() assessmentId: string;
  @Column() filename: string;
  @Column() sourceType: string; // pdf | docx | csv | txt
  @Column() contentHash: string;
  @Column({ type: 'text', nullable: true }) extractedText: string;
  @Column({ default: 'pending' }) extractionStatus: string; // pending|extracted|failed
  @Column({ default: 'reported' }) evidenceStatus: string; // reported|documented|verified|outdated|awaiting_review
  @CreateDateColumn() uploadedAt: Date;
}

@Entity('risks')
export class Risk {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Index() @Column() assessmentId: string;
  @Column({ nullable: true }) assetId: string;
  @Column() title: string;
  @Column({ type: 'text', nullable: true }) description: string;
  @Column({ default: 'open' }) status: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('risk_versions')
export class RiskVersion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() riskId: string;
  @Column({ type: 'int' }) versionNo: number;
  @Column({ type: 'int', nullable: true }) likelihood: number;
  @Column({ type: 'int', nullable: true }) impact: number;
  @Column({ type: 'int', nullable: true }) score: number;
  @Column({ nullable: true }) band: string; // low|medium|high|critical
  @Column({ default: 'current' }) basis: string; // current | projected
  @Column({ type: 'text', nullable: true }) rationale: string;
  @Column({ default: 'draft' }) status: string; // draft | approved
  @Column({ default: false }) consequenceReview: boolean;
  @Column({ nullable: true }) approvedBy: string;
  @Column({ nullable: true }) approvedAt: string; // ISO string
  @CreateDateColumn() createdAt: Date;
}

@Entity('controls')
export class Control {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) controlCode: string;
  @Column({ type: 'text' }) description: string;
  @Column() complexity: string; // essential | recommended | advanced
  @Column() framework: string;
  @Column() referenceCode: string;
}

@Entity('recommendations')
export class Recommendation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Index() @Column() riskVersionId: string;
  @Column() controlId: string;
  @Column() priority: string; // immediate | scheduled | longer_term
  @Column({ type: 'text', nullable: true }) rationale: string;
  @Column({ default: 'proposed' }) status: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('actions')
export class ActionItem {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Column() title: string;
  @Column({ default: 'assigned' }) status: string;
  // draft|assigned|in_progress|awaiting_verification|verified|returned
  @Column({ nullable: true }) ownerEmail: string;
  @Column({ nullable: true }) dueAt: string; // ISO string
  @Column({ type: 'simple-json', nullable: true }) recommendationIds: string[];
  @Column({ type: 'text', nullable: true }) submissionNote: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('action_reviews')
export class ActionReview {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() actionId: string;
  @Column() reviewerId: string;
  @Column() decision: string; // verified | returned
  @Column({ type: 'text', nullable: true }) reason: string;
  @CreateDateColumn() reviewedAt: Date;
}

@Entity('alerts')
export class Alert {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Column() severity: string; // low|medium|high|critical
  @Column({ default: 'open' }) state: string; // open|acknowledged|resolved
  @Column({ type: 'text' }) message: string;
  @Column() source: string; // overdue_action|urgent_risk|consequence_review|evidence_review
  @Index() @Column() dedupKey: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('ai_runs')
export class AiRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Index() @Column({ nullable: true }) assessmentId: string;
  @Column({ nullable: true }) parentRunId: string;
  @Column() provider: string; // openai | anthropic
  @Column() model: string;
  @Column() status: string; // succeeded | failed
  @Column({ type: 'simple-json', nullable: true }) output: any;
  @Column({ type: 'text', nullable: true }) error: string;
  @Column({ type: 'simple-json', nullable: true }) usage: any;
  @CreateDateColumn() createdAt: Date;
}

@Entity('reports')
export class Report {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() organisationId: string;
  @Index() @Column() assessmentId: string;
  @Column() requestedBy: string;
  @Column({ default: 'generated' }) status: string;
  @Column({ type: 'simple-json' }) snapshot: any;
  @CreateDateColumn() createdAt: Date;
}

export const ALL_ENTITIES = [
  User,
  Organisation,
  Asset,
  Assessment,
  EvidenceDocument,
  Risk,
  RiskVersion,
  Control,
  Recommendation,
  ActionItem,
  ActionReview,
  Alert,
  AiRun,
  Report,
];
