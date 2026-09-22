import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActionItem, ActionReview } from '../entities';
import { CurrentUser, JwtUser } from '../auth/auth';
import { TenancyService } from '../organisations/organisations.controller';

// Action lifecycle (dissertation §4.11):
// draft -> assigned -> in_progress -> awaiting_verification -> verified | returned
// A verified action never rewrites an approved risk score (FR09).

@Controller()
export class ActionsController {
  constructor(
    @InjectRepository(ActionItem) private readonly actions: Repository<ActionItem>,
    @InjectRepository(ActionReview) private readonly reviews: Repository<ActionReview>,
    private readonly tenancy: TenancyService,
  ) {}

  private async assertAction(id: string, userId: string): Promise<ActionItem> {
    const action = await this.actions.findOneBy({ id });
    if (!action) throw new NotFoundException('Action not found');
    await this.tenancy.assertOrg(action.organisationId, userId);
    return action;
  }

  @Get('organisations/:orgId/actions')
  async list(@CurrentUser() user: JwtUser, @Param('orgId') orgId: string) {
    await this.tenancy.assertOrg(orgId, user.sub);
    return this.actions.find({ where: { organisationId: orgId }, order: { createdAt: 'DESC' } });
  }

  @Post('organisations/:orgId/actions')
  async create(
    @CurrentUser() user: JwtUser,
    @Param('orgId') orgId: string,
    @Body()
    body: { title?: string; dueAt?: string; ownerEmail?: string; recommendationIds?: string[] },
  ) {
    await this.tenancy.assertOrg(orgId, user.sub);
    const title = (body.title || '').trim();
    if (!title) throw new BadRequestException('Action title is required');
    // Assigned actions require an owner and due date (Appendix A integrity rule).
    const hasOwner = !!(body.ownerEmail || '').trim();
    const dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (dueAt && isNaN(dueAt.getTime())) throw new BadRequestException('dueAt must be a valid date');
    return this.actions.save(
      this.actions.create({
        organisationId: orgId,
        title,
        status: hasOwner && dueAt ? 'assigned' : 'draft',
        ownerEmail: body.ownerEmail || null,
        dueAt: dueAt ? dueAt.toISOString() : null,
        recommendationIds: Array.isArray(body.recommendationIds) ? body.recommendationIds : [],
      }),
    );
  }

  @Post('actions/:id/submit-review')
  async submitReview(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ) {
    const action = await this.assertAction(id, user.sub);
    if (!['draft', 'assigned', 'in_progress', 'returned'].includes(action.status)) {
      throw new BadRequestException(`Cannot submit an action in status "${action.status}" for review`);
    }
    action.status = 'awaiting_verification';
    action.submissionNote = body.note || null;
    return this.actions.save(action);
  }

  @Post('actions/:id/reviews')
  async review(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { decision?: string; reason?: string },
  ) {
    const action = await this.assertAction(id, user.sub);
    if (action.status !== 'awaiting_verification') {
      throw new BadRequestException('Only actions awaiting verification can be reviewed');
    }
    if (!['verified', 'returned'].includes(body.decision)) {
      throw new BadRequestException('decision must be "verified" or "returned"');
    }
    // Verification creates an immutable recorded decision (FR09).
    await this.reviews.save(
      this.reviews.create({
        actionId: action.id,
        reviewerId: user.sub,
        decision: body.decision,
        reason: body.reason || null,
      }),
    );
    action.status = body.decision === 'verified' ? 'verified' : 'returned';
    return this.actions.save(action);
  }
}
