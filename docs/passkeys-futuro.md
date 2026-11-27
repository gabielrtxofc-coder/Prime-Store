# Direção futura: Passkeys e autenticação por PIN/biometria do dispositivo

> **Status: NÃO implementado nesta missão — apenas documentação de intenção.**
> A prioridade da missão era estabilizar a arquitetura atual (TOTP + AAL2).
> Nada deste documento altera o comportamento em produção.

## O que se deseja no futuro

Permitir que os administradores usem **Passkeys** (WebAuthn/FIDO2) como
autenticador, com a confirmação local do dispositivo — **PIN do aparelho ou
biometria** (impressão digital / rosto) — como gesto de desbloqueio da chave
privada. Para o usuário, isso reduz atrito (sem digitar códigos de 6 dígitos);
para a segurança, a chave privada nunca sai do dispositivo.

## Por que NÃO foi implementado agora

1. **Modelo AAL2 do banco é TOTP-centered hoje.** A guarda de segurança exige
   `aal = aal2` (`assert_admin()`), e o caminho de elevação configurado é o
   desafio TOTP do Supabase Auth. Não há, validado e estável, suporte explícito
   para usar Passkey como **segundo fator** dentro desse modelo AAL2 — os
   proveedores de auth disponíveis no projeto (Supabase Auth) não expõem, de
   forma estável, WebAuthn como fator MFA com promoção de AAL equivalente.
2. **Risco de bypass disfarçado de melhoria.** Um PIN próprio dentro do
   formulário da Prime Store, SMS no lugar do TOTP, "confiar neste
   dispositivo" ou qualquer mecanismo experimental apresentado como segurança
   definitiva **enfraqueceria** a garantia atual (algo que você sabe + algo que
   você tem, verificável pelo servidor). Isso foi explicitamente excluído.
3. **Não há liberação do painel sem autenticação adequada.** Qualquer caminho
   novo teria de provar, com testes de banco equivalentes ao `tests/db/22`,
   que a sessão só chega a `aal2` após verificação verificável pelo servidor.

## Condições para implementar (checklist futuro)

- [ ] Suporte estável e documentado do provedor de Auth para **Passkey como
      fator MFA** com elevação de AAL reconhecida pelo banco.
- [ ] Guarda `assert_admin()`/AAL2 validada com novos testes de banco
      (equivalentes a `tests/db/22_admin_guardia_aal2.test.ts`).
- [ ] Verificação de que a Passkey exige **user verification** (PIN/biometria
      do dispositivo) na atuação como segundo fator.
- [ ] Recuperação: fluxo com autenticador TOTP reserva enquanto a Passkey não
      funciona (conta nunca pode ficar sem segundo fator funcional).
- [ ] Homologação pelos dois administradores em ambiente de homologação antes
      de produção, sem remover os autenticadores TOTP antigos.

## Fora de escopo (decisão permanente enquanto o modelo atual vigorar)

- PIN próprio implementado pela Prime Store dentro do formulário.
- SMS como substituto do TOTP.
- Opção de "confiar permanentemente neste dispositivo".
- Qualquer bypass de MFA.
- Mecanismos experimentais apresentados como mecanismo de segurança definitivo.
