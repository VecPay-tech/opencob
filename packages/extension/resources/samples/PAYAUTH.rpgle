**FREE
// PAYAUTH - Real-time card authorization
// Validates card, checks daily limit, posts authorization result.

ctl-opt dftactgrp(*no) actgrp('PAYAUTH') option(*srcstmt);

dcl-f CARDMST   disk(*ext) keyed usage(*update);
dcl-f AUTHHIST  disk(*ext) usage(*output);
dcl-f LIMITTBL  disk(*ext) keyed usage(*input);

dcl-ds authRequest qualified;
  cardNo    char(16);
  expiry    char(6);
  amount    packed(13:2);
  currency  char(3);
  merchantId char(15);
end-ds;

dcl-ds cardRec extname('CARDMST') qualified;
end-ds;

dcl-ds authRec extname('AUTHHIST') qualified;
end-ds;

dcl-s isValid     ind;
dcl-s isOverLimit ind;
dcl-s authCode    char(6);

// Entry point: processes authorization request and posts result
dcl-proc authorize export;
  dcl-pi *n;
    request  likeds(authRequest);
    authOut  char(6);
    decFlag  ind;
  end-pi;

  callp CARDCHECK(request.cardNo : request.expiry : isValid);

  if not isValid;
    authOut  = *blanks;
    decFlag  = *on;
    callp POSTDECLN(request : authOut);
    return;
  endif;

  callp LIMITCHK(request.cardNo : request.amount : isOverLimit);

  if isOverLimit;
    authOut  = *blanks;
    decFlag  = *on;
    callp POSTDECLN(request : authOut);
    return;
  endif;

  callp AUTHGEN(request.cardNo : request.amount : authCode);

  decFlag  = *off;
  callp POSTAPPR(request : authCode);

  authOut  = authCode;
end-proc;

dcl-proc validateCard;
  dcl-pi *n ind;
    cardNo  char(16);
    expiry  char(6);
  end-pi;

  chain cardNo CARDMST;
  if not %found();
    return *off;
  endif;
  return (cardRec.status = 'A' and cardRec.expiry >= expiry);
end-proc;

dcl-proc checkDailyLimit;
  dcl-pi *n ind;
    cardNo  char(16);
    amount  packed(13:2);
  end-pi;

  chain cardNo LIMITTBL;
  if not %found();
    return *off;
  endif;
  return (cardRec.dailyUsed + amount > cardRec.dailyLimit);
end-proc;

dcl-proc generateAuthCode;
  dcl-pi *n char(6);
    cardNo  char(16);
    amount  packed(13:2);
  end-pi;

  dcl-s seed  packed(20:0);
  seed = %dec(cardNo : 16 : 0) + %dec(%char(amount) : 13 : 0);
  return %char(%rem(seed : 900000) + 100000 : 6);
end-proc;

dcl-proc postApproval;
  dcl-pi *n;
    request  likeds(authRequest);
    authCode char(6);
  end-pi;

  authRec.cardNo   = request.cardNo;
  authRec.amount   = request.amount;
  authRec.authCode = authCode;
  authRec.status   = 'A';
  authRec.tstamp   = %timestamp();
  write AUTHHISTR authRec;
end-proc;

dcl-proc postDecline;
  dcl-pi *n;
    request  likeds(authRequest);
  end-pi;

  authRec.cardNo   = request.cardNo;
  authRec.amount   = request.amount;
  authRec.authCode = *blanks;
  authRec.status   = 'D';
  authRec.tstamp   = %timestamp();
  write AUTHHISTR authRec;
end-proc;
