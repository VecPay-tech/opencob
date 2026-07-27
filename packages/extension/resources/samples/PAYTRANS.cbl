       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYTRANS.
       AUTHOR. PAYTECH.
      *=============================================================*
      * PAYTRANS - BATCH PAYMENT TRANSACTION PROCESSOR              *
      * Reads daily transaction file, validates, calculates fees,   *
      * and writes to payment log.                                  *
      *=============================================================*
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT TRANSACT-FILE ASSIGN TO 'QTXLIB/TRANSACT'
               ORGANIZATION IS SEQUENTIAL.
           SELECT PAYMENT-LOG   ASSIGN TO 'QTXLIB/PAYLOG'
               ORGANIZATION IS SEQUENTIAL.
       DATA DIVISION.
       FILE SECTION.
       FD  TRANSACT-FILE.
       01  TRANS-RECORD.
           05  TR-TRANS-ID        PIC X(10).
           05  TR-ACCOUNT-NO      PIC X(16).
           05  TR-AMOUNT          PIC S9(9)V99 COMP-3.
           05  TR-TRANS-TYPE      PIC X.
               88  TR-PAYMENT     VALUE 'P'.
               88  TR-REFUND      VALUE 'R'.
               88  TR-TRANSFER    VALUE 'T'.
           05  TR-CURRENCY        PIC X(3).
           05  TR-TIMESTAMP       PIC X(26).
       FD  PAYMENT-LOG.
       01  LOG-RECORD.
           05  LG-TRANS-ID        PIC X(10).
           05  LG-STATUS          PIC X(2).
           05  LG-FEE-AMT         PIC S9(9)V99 COMP-3.
           05  LG-NET-AMT         PIC S9(9)V99 COMP-3.
           05  LG-ERROR-MSG       PIC X(80).
       WORKING-STORAGE SECTION.
           COPY PAYTYPES.
       01  WS-FLAGS.
           05  WS-EOF             PIC X VALUE 'N'.
               88  END-OF-FILE    VALUE 'Y'.
           05  WS-VALID           PIC X VALUE 'N'.
               88  TRANS-VALID    VALUE 'Y'.
       01  WS-COUNTERS.
           05  WS-PROC-COUNT      PIC 9(7) VALUE ZERO.
           05  WS-ERR-COUNT       PIC 9(7) VALUE ZERO.
           05  WS-FEE-TOTAL       PIC S9(11)V99 COMP-3 VALUE ZERO.
       PROCEDURE DIVISION.
       MAIN-PARA.
           PERFORM OPEN-FILES
           PERFORM PROCESS-TRANSACTIONS UNTIL END-OF-FILE
           PERFORM CLOSE-FILES
           STOP RUN.
       OPEN-FILES.
           OPEN INPUT  TRANSACT-FILE
               OUTPUT PAYMENT-LOG.
       PROCESS-TRANSACTIONS.
           READ TRANSACT-FILE
               AT END MOVE 'Y' TO WS-EOF
               NOT AT END
                   PERFORM VALIDATE-TRANS
                   IF TRANS-VALID
                       PERFORM CALC-FEES
                       PERFORM WRITE-LOG
                   ELSE
                       PERFORM LOG-ERROR
                   END-IF
                   ADD 1 TO WS-PROC-COUNT
           END-READ.
       VALIDATE-TRANS.
           MOVE 'Y' TO WS-VALID
           EVALUATE TRUE
               WHEN TR-PAYMENT
                   CALL 'PAYVALID' USING TRANS-RECORD WS-VALID
               WHEN TR-REFUND
                   CALL 'RFDVALID' USING TRANS-RECORD WS-VALID
               WHEN TR-TRANSFER
                   CALL 'XFRVALID' USING TRANS-RECORD WS-VALID
               WHEN OTHER
                   MOVE 'N' TO WS-VALID
           END-EVALUATE.
       CALC-FEES.
           CALL 'FEECALC' USING TR-AMOUNT TR-TRANS-TYPE
                               LG-FEE-AMT LG-NET-AMT
           ADD LG-FEE-AMT TO WS-FEE-TOTAL.
       WRITE-LOG.
           MOVE TR-TRANS-ID TO LG-TRANS-ID
           MOVE 'OK'        TO LG-STATUS
           MOVE SPACES      TO LG-ERROR-MSG
           WRITE LOG-RECORD.
       LOG-ERROR.
           MOVE TR-TRANS-ID   TO LG-TRANS-ID
           MOVE 'ER'          TO LG-STATUS
           MOVE ZEROS         TO LG-FEE-AMT LG-NET-AMT
           MOVE 'VALIDATION FAILED' TO LG-ERROR-MSG
           WRITE LOG-RECORD
           ADD 1 TO WS-ERR-COUNT.
       CLOSE-FILES.
           CLOSE TRANSACT-FILE PAYMENT-LOG.
