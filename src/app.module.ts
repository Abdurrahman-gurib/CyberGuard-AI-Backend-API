import { Controller, Get, Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule, InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ALL_ENTITIES, Control } from './entities';
import { AuthController, JwtAuthGuard, Public } from './auth/auth';
import { OrganisationsController, TenancyService } from './organisations/organisations.controller';
import { AssessmentsController } from './assessments/assessments.controller';
import { ControlsController, RisksController } from './risks/risks.controller';
import { ActionsController } from './actions/actions.controller';
import { AlertsController } from './alerts/alerts.controller';
import { AiController } from './ai/ai.controller';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: 'cyberguard-ai-backend', time: new Date().toISOString() };
  }
}

// Curated control catalogue (mirrors database/seed.sql) seeded on first boot.
const CONTROL_SEED: Array<Partial<Control>> = [
  { controlCode: 'CG-AC-01', description: 'Enforce multi-factor authentication for all remote and administrative access.', complexity: 'essential', framework: 'NIST CSF 2.0', referenceCode: 'PR.AA' },
  { controlCode: 'CG-AC-02', description: 'Review privileged accounts and remove unused access on a defined schedule.', complexity: 'essential', framework: 'ISO/IEC 27002:2022', referenceCode: '8.2' },
  { controlCode: 'CG-AC-03', description: 'Apply least-privilege role-based access control to business systems.', complexity: 'recommended', framework: 'ISO/IEC 27002:2022', referenceCode: '5.15' },
  { controlCode: 'CG-BK-01', description: 'Perform daily backups of critical data and store one copy off-site/immutable.', complexity: 'essential', framework: 'NIST CSF 2.0', referenceCode: 'PR.DS' },
  { controlCode: 'CG-BK-02', description: 'Test backup restoration on a defined schedule and record the evidence.', complexity: 'recommended', framework: 'ISO/IEC 27002:2022', referenceCode: '8.13' },
  { controlCode: 'CG-VM-01', description: 'Apply security patches to internet-facing systems within an agreed SLA.', complexity: 'essential', framework: 'NIST CSF 2.0', referenceCode: 'ID.RA' },
  { controlCode: 'CG-VM-02', description: 'Maintain an asset inventory with product names and versions for advisory matching.', complexity: 'recommended', framework: 'NIST CSF 2.0', referenceCode: 'ID.AM' },
  { controlCode: 'CG-IR-01', description: 'Maintain and exercise a documented incident response plan.', complexity: 'recommended', framework: 'NIST CSF 2.0', referenceCode: 'RS.MA' },
  { controlCode: 'CG-IR-02', description: 'Enable centralised security logging for critical services with retention.', complexity: 'advanced', framework: 'ISO/IEC 27002:2022', referenceCode: '8.15' },
  { controlCode: 'CG-AW-01', description: 'Deliver phishing and security awareness training to all staff.', complexity: 'essential', framework: 'ISO/IEC 27002:2022', referenceCode: '6.3' },
  { controlCode: 'CG-NT-01', description: 'Segment networks so critical services are isolated from general user networks.', complexity: 'advanced', framework: 'NIST CSF 2.0', referenceCode: 'PR.IR' },
  { controlCode: 'CG-CR-01', description: 'Encrypt sensitive data at rest and in transit using current standards.', complexity: 'recommended', framework: 'ISO/IEC 27002:2022', referenceCode: '8.24' },
  { controlCode: 'CG-SP-01', description: "Assess critical suppliers' security posture and record contractual obligations.", complexity: 'recommended', framework: 'NIST CSF 2.0', referenceCode: 'GV.SC' },
  { controlCode: 'CG-EP-01', description: 'Deploy endpoint protection with centrally monitored alerts on all devices.', complexity: 'essential', framework: 'ISO/IEC 27002:2022', referenceCode: '8.7' },
  { controlCode: 'CG-REC-01', description: 'Reconcile stated policy requirements against operational evidence (e.g. backup reports).', complexity: 'recommended', framework: 'NIST CSF 2.0', referenceCode: 'GV.OV' },
];

function databaseConfig() {
  const url = process.env.DATABASE_URL;
  if (url) {
    return {
      type: 'postgres' as const,
      url,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
      entities: ALL_ENTITIES,
      synchronize: true, // prototype schema management; reference DDL in database/schema.sql
    };
  }
  return {
    type: 'better-sqlite3' as const,
    database: 'cyberguard.sqlite',
    entities: ALL_ENTITIES,
    synchronize: true,
  };
}

@Module({
  imports: [
    TypeOrmModule.forRoot(databaseConfig()),
    TypeOrmModule.forFeature(ALL_ENTITIES),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'cyberguard-dev-secret',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '12h' },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    OrganisationsController,
    AssessmentsController,
    RisksController,
    ControlsController,
    ActionsController,
    AlertsController,
    AiController,
  ],
  providers: [TenancyService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule implements OnModuleInit {
  constructor(@InjectRepository(Control) private readonly controls: Repository<Control>) {}

  async onModuleInit() {
    for (const seed of CONTROL_SEED) {
      const existing = await this.controls.findOneBy({ controlCode: seed.controlCode });
      if (!existing) await this.controls.save(this.controls.create(seed));
    }
  }
}
