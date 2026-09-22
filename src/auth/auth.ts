import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../entities';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user,
);

export interface JwtUser {
  sub: string;
  email: string;
  displayName: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string = request.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    try {
      request.user = await this.jwt.verifyAsync<JwtUser>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  private async issue(user: User) {
    const payload: JwtUser = {
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
    };
    return {
      token: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }

  @Public()
  @Post('register')
  async register(@Body() body: { email?: string; password?: string; displayName?: string }) {
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const displayName = (body.displayName || '').trim();
    if (!email.includes('@')) throw new BadRequestException('A valid email is required');
    if (password.length < 6) throw new BadRequestException('Password must be at least 6 characters');
    if (!displayName) throw new BadRequestException('Display name is required');

    const existing = await this.users.findOneBy({ email });
    if (existing) throw new BadRequestException('An account with this email already exists');

    const user = await this.users.save(
      this.users.create({ email, displayName, passwordHash: await bcrypt.hash(password, 10) }),
    );
    return this.issue(user);
  }

  @Public()
  @Post('login')
  async login(@Body() body: { email?: string; password?: string }) {
    const email = (body.email || '').trim().toLowerCase();
    const user = await this.users.findOneBy({ email });
    if (!user || !(await bcrypt.compare(body.password || '', user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issue(user);
  }
}
