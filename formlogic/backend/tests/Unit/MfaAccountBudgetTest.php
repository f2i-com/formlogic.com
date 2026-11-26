<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AuthController;
use FormLogic\Models\User;
use FormLogic\Services\AuthService;
use FormLogic\Services\MfaService;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * The sign-in code step counts its answers against the account, not only against the prompt
 * (five) and the address (fifteen in five minutes). Whoever knows the password gets a new prompt
 * by signing in again, from as many addresses as they have, so those two bounded nobody. Here:
 * what the two sign-in routes do with the account's budget (MfaService keeps the count; the
 * count itself is covered against a database in MfaFlowTest).
 */
final class MfaAccountBudgetTest extends TestCase
{
    private User $user;
    private AuthService&MockObject $auth;
    private MfaService&MockObject $mfa;
    private AuthController $controller;

    protected function setUp(): void
    {
        $this->user = new User('user-1', 'ada@example.test');
        $this->auth = $this->createMock(AuthService::class);
        $this->auth->method('getUserById')->willReturn($this->user);
        $this->auth->method('consumeMfaPendingToken')->willReturn(['user' => $this->user, 'jti' => 'jti-1']);
        $this->auth->method('issueMfaPendingToken')->willReturn(['token' => 'pending-token', 'jti' => 'jti-1']);
        $this->auth->method('issueToken')->willReturn('session-token');
        $this->auth->method('userPayload')->willReturn(['id' => 'user-1']);
        $this->auth->method('login')->willReturn(['user' => ['id' => 'user-1'], 'token' => 'session-token']);
        $this->mfa = $this->createMock(MfaService::class);
        $this->mfa->method('isEnabled')->willReturn(true);
        $this->mfa->method('secondFactorMinutesLeft')->willReturn(7);
        $this->controller = new AuthController($this->auth, mfaService: $this->mfa);
    }

    /** @return array{0: int, 1: array<string, mixed>, 2: ResponseInterface} */
    private function answerCode(): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/auth/mfa/verify')
            ->withParsedBody(['mfaToken' => 'pending-token', 'code' => '123456']);
        $response = $this->controller->mfaVerify($request, (new ResponseFactory())->createResponse());
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true) ?: [], $response];
    }

    /** @return array{0: int, 1: array<string, mixed>, 2: ResponseInterface} */
    private function signIn(): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/auth/login')
            ->withParsedBody(['email' => 'ada@example.test', 'password' => 'correct-horse']);
        $response = $this->controller->login($request, (new ResponseFactory())->createResponse());
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true) ?: [], $response];
    }

    public function testAnAnswerOverTheAccountsBudgetIsRefusedUnread(): void
    {
        $this->mfa->method('challengeAttempt')->willReturn(true);
        $this->mfa->method('secondFactorAttempt')->willReturn(false);
        // Not even a right code: looking at it at all is the guess being counted.
        $this->mfa->expects($this->never())->method('verifyChallenge');
        $this->mfa->expects($this->never())->method('claimChallenge');

        [$status, $body, $response] = $this->answerCode();

        $this->assertSame(429, $status);
        $this->assertSame('Too many incorrect verification codes for this account. Please try again in 7 minute(s).', $body['message']);
        $this->assertSame([], $response->getHeader('Set-Cookie'));
    }

    public function testAnAnswerThatCannotBeCountedIsRefused(): void
    {
        $this->mfa->method('challengeAttempt')->willReturn(true);
        $this->mfa->method('secondFactorAttempt')->willReturn(null);
        $this->mfa->expects($this->never())->method('verifyChallenge');

        [$status, $body, $response] = $this->answerCode();

        $this->assertSame(503, $status);
        $this->assertTrue($body['retryable']);
        $this->assertSame([], $response->getHeader('Set-Cookie'));
    }

    public function testAnAnswerToASpentPromptIsNotCountedAgainstTheAccount(): void
    {
        // An old pending token replayed is no guess at the code, and must not use up the budget.
        $this->mfa->method('challengeAttempt')->willReturn(false);
        $this->mfa->expects($this->never())->method('secondFactorAttempt');

        $this->assertSame(401, $this->answerCode()[0]);
    }

    public function testAWrongCodeLeavesTheCountStanding(): void
    {
        $this->mfa->method('challengeAttempt')->willReturn(true);
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturn(true);
        $this->mfa->method('verifyChallenge')->willReturn(false);
        $this->mfa->expects($this->never())->method('secondFactorPassed');
        $this->auth->expects($this->never())->method('signInCompleted');

        $this->assertSame(401, $this->answerCode()[0]);
    }

    public function testTheRightCodeEndsBothCountsAgainstTheAccount(): void
    {
        $this->mfa->method('challengeAttempt')->willReturn(true);
        $this->mfa->method('secondFactorAttempt')->willReturn(true);
        $this->mfa->method('verifyChallenge')->willReturn(true);
        $this->mfa->method('claimChallenge')->willReturn(true);
        $this->mfa->expects($this->once())->method('secondFactorPassed')->with('user-1');
        $this->auth->expects($this->once())->method('signInCompleted')->with($this->user);

        [$status, , $response] = $this->answerCode();

        $this->assertSame(200, $status);
        $this->assertStringContainsString('formlogic_auth=session-token', implode(';', $response->getHeader('Set-Cookie')));
    }

    public function testThePasswordGetsNoNewPromptWhileTheAccountIsOverItsBudget(): void
    {
        $this->mfa->method('checkTrust')->willReturn(false);
        $this->mfa->method('secondFactorLocked')->willReturn(true);
        $this->auth->expects($this->never())->method('issueMfaPendingToken');
        $this->mfa->expects($this->never())->method('registerChallenge');

        [$status, $body, $response] = $this->signIn();

        $this->assertSame(429, $status);
        $this->assertStringStartsWith('Too many incorrect verification codes for this account', $body['message']);
        $this->assertArrayNotHasKey('mfaToken', $body);
        $this->assertSame([], $response->getHeader('Set-Cookie'));
    }

    public function testThePasswordIsAskedForACodeWhileTheAccountIsWithinItsBudget(): void
    {
        $this->mfa->method('checkTrust')->willReturn(false);
        $this->mfa->method('secondFactorLocked')->willReturn(false);
        $this->mfa->expects($this->once())->method('registerChallenge')->with('user-1', 'jti-1');
        // The password is half the sign-in: nothing ends the account's count yet.
        $this->auth->expects($this->never())->method('signInCompleted');

        [$status, $body, $response] = $this->signIn();

        $this->assertSame(200, $status);
        $this->assertSame(['mfaRequired' => true, 'mfaToken' => 'pending-token'], $body);
        $this->assertSame([], $response->getHeader('Set-Cookie'));
    }

    public function testABrowserTheAccountRemembersCompletesTheSignIn(): void
    {
        $this->mfa->method('checkTrust')->willReturn(true);
        // It is not asked for a code, so the budget of code answers is not its concern.
        $this->mfa->expects($this->never())->method('secondFactorLocked');
        $this->auth->expects($this->once())->method('signInCompleted')->with($this->user);

        [$status, , $response] = $this->signIn();

        $this->assertSame(200, $status);
        $this->assertStringContainsString('formlogic_auth=session-token', implode(';', $response->getHeader('Set-Cookie')));
    }
}
