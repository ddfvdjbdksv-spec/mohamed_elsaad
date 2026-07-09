// ============================================================
//  session-subscription.js  —  نظام الاشتراك بالحصة (مستقل تماماً)
// ------------------------------------------------------------
//  ✅ لا يعدّل أي منطق خاص بالاشتراك الشهري إطلاقاً.
//  ✅ كل بياناته منفصلة عن db.payments الخاصة بالاشتراك الشهري عن طريق
//     category: 'اشتراك بالحصة' (بدلاً من 'اشتراك شهري').
//  ✅ يعمل بجانب النظام الحالي عبر:
//      - إضافة حقل s.subscriptionMode ('monthly' | 'session') لكل طالب
//        (افتراضياً 'monthly' فلا يتأثر أي طالب قديم).
//      - تحديد نوع الاشتراك يتم فقط من شاشة "الخزينة والمالية".
//      - سعر الحصة الواحدة يُحدَّد لكل مجموعة/صف دراسي على حدة.
//      - فترة الحساب (لتجميع الحصص في التقرير) فترة مخصّصة يحددها
//        المستخدم يدوياً (مثل الترم) — منفصلة تماماً عن دورة الاشتراك
//        الشهري (activeCycle).
//
//  ⚠️ ملاحظة تخزين مهمة: db.settings هي getter "ديناميكي" مرتبط
//     بالمجموعة/الصف المفتوحين حالياً (يرجع db._settings[grade_group]).
//     بيانات الاشتراك بالحصة (فترات الحساب + الأرشيف) لازم تكون
//     عامة على كل النظام، فبنخزّنها مباشرة داخل db._settings (الجذر)
//     لأنه الكائن الوحيد اللي بيتحفظ فعليًا في localStorage مع أي
//     db.save(...) — بعكس أي مصفوفة جديدة (زي db.sessionPeriods) اللي
//     مكنش هيتم حفظها لأنها مش object store معرّف في IndexedDB.
// ============================================================

const SessionSub = (function () {

    // ──────────────────────────────────────────────────────
    //  0) تهيئة هياكل البيانات (بدون كسر أي بيانات قديمة)
    // ──────────────────────────────────────────────────────
    function ensureDataShape() {
        if (!db._settings) db._settings = {};
        if (!db._settings.sessionFeeByGroup) db._settings.sessionFeeByGroup = {};
        if (!Array.isArray(db._settings.sessionPeriods)) db._settings.sessionPeriods = [];
        if (db._settings.activeSessionPeriodId === undefined) db._settings.activeSessionPeriodId = null;
        if (!Array.isArray(db._settings.sessionArchive)) db._settings.sessionArchive = [];
        // ✅ أرشيف مستقل لكل "حصة" (جلسة تشفير) على حدة — منفصل عن أرشيف فترات الحساب أعلاه
        if (!Array.isArray(db._settings.lessonSessionArchive)) db._settings.lessonSessionArchive = [];
        // ✅ مفتاح عام: تفعيل/إلغاء الاشتراك بالحصة لجميع الطلاب دفعة واحدة
        if (db._settings.sessionModeGlobalActive === undefined) db._settings.sessionModeGlobalActive = false;
        // ✅ سجل تنفيذ جلسات "تشفير الحصة" (لأغراض الإحصائيات فقط)
        if (!Array.isArray(db._settings.encryptionSessionLog)) db._settings.encryptionSessionLog = [];
    }

    /** يحفظ db._settings فعليًا في localStorage (نفس ما يفعله db.save() دايمًا بغض النظر عن اسم الجدول) */
    function persist() {
        try {
            localStorage.setItem('edu_master_settings', JSON.stringify(db._settings));
        } catch (e) { /* تجاهل */ }
        // كمان استدعِ db.save() لو موجودة عشان أي مزامنة إضافية (سحابية...إلخ) تحصل بنفس الآلية المعتادة
        if (typeof db.save === 'function') {
            try { db.save('groups'); } catch (e) { /* تجاهل */ }
        }
    }

    // ──────────────────────────────────────────────────────
    //  1) نوع اشتراك الطالب (شهري / بالحصة)
    // ──────────────────────────────────────────────────────
    function isSessionStudent(s) {
        return !!s && s.subscriptionMode === 'session';
    }

    function setStudentSubscriptionMode(studentId, mode) {
        ensureDataShape();
        const s = db.students.find(x => x.id == studentId);
        if (!s) return;
        s.subscriptionMode = (mode === 'session') ? 'session' : 'monthly';
        db.save('students');
        showNotification(
            `تم ضبط نوع اشتراك ${s.name} إلى: ${s.subscriptionMode === 'session' ? 'اشتراك بالحصة' : 'اشتراك شهري'} ✅`,
            'success'
        );
        if (typeof renderFinances === 'function') renderFinances();
        renderModeIndicator();
        renderPanel();
    }

    // ──────────────────────────────────────────────────────
    //  1.1) مفتاح عام: تفعيل/إلغاء الاشتراك بالحصة لكل الطلاب دفعة واحدة
    // ──────────────────────────────────────────────────────
    function isGlobalSessionModeActive() {
        ensureDataShape();
        return !!db._settings.sessionModeGlobalActive;
    }

    /**
     * يُنفَّذ فقط عند تغيير المفتاح فعليًا (من onchange في الواجهة) — لا يُستدعى
     * تلقائيًا عند فتح البرنامج، فلا يتكرر التحويل مع كل تحميل للصفحة.
     * ON  → كل الطلاب: subscriptionMode = 'session'
     * OFF → كل الطلاب: subscriptionMode = 'monthly'
     * لا يُنشئ أو يُعدّل أي حقل آخر في بيانات الطالب (لا تكرار بيانات).
     */
    function setGlobalSessionMode(active) {
        ensureDataShape();
        const wantActive = !!active;

        // Idempotent: لو الحالة المطلوبة هي نفسها الحالية بالفعل، لا تنفّذ التحويل مرة أخرى
        if (db._settings.sessionModeGlobalActive === wantActive) {
            renderPanel();
            return;
        }

        const confirmMsg = wantActive
            ? 'سيتم تحويل جميع الطلاب في النظام إلى "اشتراك بالحصة" تلقائيًا. هل تريد المتابعة؟'
            : 'سيتم إرجاع جميع الطلاب في النظام إلى "اشتراك شهري" تلقائيًا. هل تريد المتابعة؟';
        if (!confirm(confirmMsg)) {
            renderPanel(); // أعد رسم اللوحة عشان زر الـ toggle يرجع لحالته الفعلية (لم يتغيّر شيء)
            return;
        }

        const newMode = wantActive ? 'session' : 'monthly';
        db.students.forEach(s => { s.subscriptionMode = newMode; });
        db.save('students');

        db._settings.sessionModeGlobalActive = wantActive;
        persist();

        showNotification(
            wantActive
                ? 'تم تحويل جميع الطلاب إلى "اشتراك بالحصة" ✅'
                : 'تم إرجاع جميع الطلاب إلى "اشتراك شهري" ✅',
            'success'
        );

        if (typeof renderFinances === 'function') renderFinances();
        renderModeIndicator();
        renderPanel();
    }

    // ──────────────────────────────────────────────────────
    //  2) سعر الحصة لكل مجموعة/صف
    // ──────────────────────────────────────────────────────
    function getGroupSessionFee(groupId) {
        ensureDataShape();
        return Number(db._settings.sessionFeeByGroup[groupId] || 0);
    }

    function setGroupSessionFee(groupId, fee) {
        ensureDataShape();
        db._settings.sessionFeeByGroup[groupId] = Number(fee) || 0;
        persist();
        showNotification('تم حفظ سعر الحصة لهذه المجموعة ✅', 'success');
        renderPanel();
    }

    function getStudentSessionFee(student) {
        return getGroupSessionFee(student.groupId);
    }

    // ──────────────────────────────────────────────────────
    //  3) فترة الحساب المخصّصة (بالحصة) — منفصلة عن activeCycle
    // ──────────────────────────────────────────────────────
    function getActiveSessionPeriod() {
        ensureDataShape();
        if (!db._settings.activeSessionPeriodId) return null;
        return db._settings.sessionPeriods.find(p => p.id === db._settings.activeSessionPeriodId) || null;
    }

    function getAllSessionPeriods() {
        ensureDataShape();
        return [...db._settings.sessionPeriods].sort((a, b) => b.start - a.start);
    }

    /**
     * بدء فترة حساب جديدة بالحصة (مثل بدء ترم جديد).
     * ✅ نفس فكرة "بدء الاشتراك" الشهري، لكن مستقلة تمامًا:
     *    تُقفل الفترة النشطة الحالية (لو موجودة) وتُؤرشف كل حصصها تلقائيًا
     *    قبل بدء الفترة الجديدة، فلا تضيع أي بيانات قديمة.
     */
    function startNewSessionPeriod(label) {
        ensureDataShape();
        const now = Date.now();

        // أغلق الفترة النشطة الحالية (لو موجودة) وأرشفها قبل ما تتقفل
        const active = getActiveSessionPeriod();
        if (active) {
            active.end = now;
            archivePeriod(active);
        }

        const period = {
            id: now,
            label: label && label.trim() ? label.trim() : `فترة تبدأ ${new Date(now).toLocaleDateString('ar-EG')}`,
            start: now,
            end: null // بلا نهاية لحد ما تُقفل
        };
        db._settings.sessionPeriods.push(period);
        db._settings.activeSessionPeriodId = period.id;
        persist();
        showNotification(`تم بدء فترة حساب جديدة بالحصة: ${period.label} ✅`, 'success');
        renderPanel();
        return period;
    }

    function endActiveSessionPeriod() {
        const active = getActiveSessionPeriod();
        if (!active) return showNotification('لا توجد فترة نشطة حالياً لإنهائها', 'warning');
        active.end = Date.now();
        db._settings.activeSessionPeriodId = null;
        archivePeriod(active);
        persist();
        showNotification('تم إنهاء فترة الحساب الحالية وأُرشفت كل حصصها ✅', 'success');
        renderPanel();
    }

    // ──────────────────────────────────────────────────────
    //  4) عمليات الدفع بالحصة — مرتبطة بـ"جلسة تشفير" واحدة فقط
    //     (زر "بدء تشفير الحصة" الموجود بالفعل في شاشة الحضور والمسح)
    //     وليس بسجل حضور اليوم ولا باليوم نفسه — فيسمح بالدفع مرة لكل
    //     جلسة تشفير مستقلة، مهما تكرر عدد الجلسات في نفس اليوم.
    // ──────────────────────────────────────────────────────
    function hasAttendancePaid(attendanceId) {
        return db.payments.some(p => p.category === 'اشتراك بالحصة' && p.attendanceId == attendanceId);
    }

    /**
     * ✅ إصلاح: مطابقة أكثر ثباتًا بين "الحصة" و"الدفعة" الخاصة بها.
     * المطابقة القديمة كانت تعتمد فقط على attendanceId، وهو غير متاح للحصص
     * القادمة من db.absenceSessions (لا تملك حقل id مباشر) — فكانت تظهر
     * دائمًا "غير مدفوعة" حتى لو تم الدفع فعليًا. الآن نطابق أيضًا عبر
     * (studentId + sessionId) ضد (studentId + encryptionSessionId) الخاصين بالدفعة.
     */
    function hasLessonPayment(studentId, lesson) {
        if (!lesson) return false;
        return db.payments.some(p => {
            if (p.category !== 'اشتراك بالحصة' || p.studentId != studentId) return false;
            if (lesson.id && p.attendanceId != null && p.attendanceId == lesson.id) return true;
            if (lesson.sessionId && p.encryptionSessionId != null && p.encryptionSessionId == lesson.sessionId) return true;
            return false;
        });
    }

    /** سجل تنفيذ جلسة تشفير جديدة — يُستدعى تلقائيًا من SessionManager.start() (للإحصائيات فقط) */
    function logEncryptionSessionStart(encId) {
        ensureDataShape();
        if (db._settings.encryptionSessionLog.some(l => l.id === encId)) return;
        db._settings.encryptionSessionLog.push({
            id: encId,
            grade: String(currentGrade),
            groupId: String(currentGroupId),
            startedAt: new Date().toISOString()
        });
        persist();
    }

    /** معرّف جلسة التشفير النشطة الآن لهذه المجموعة (أو null لو لا توجد جلسة نشطة) */
    function getActiveEncryptionSessionId() {
        return (typeof SessionManager !== 'undefined' && SessionManager.isActive()) ? SessionManager.currentId() : null;
    }

    /** هل الطالب حاضر ضمن جلسة التشفير النشطة حالياً؟ */
    function isStudentInCurrentEncryptionSession(student) {
        return (typeof SessionManager !== 'undefined') &&
            SessionManager.isActive() &&
            SessionManager.attendance().some(x => x.id == student.id);
    }

    function hasPaidInEncryptionSession(studentId, encId) {
        if (!encId) return false;
        return db.payments.some(p =>
            p.category === 'اشتراك بالحصة' &&
            p.studentId == studentId &&
            p.encryptionSessionId == encId
        );
    }

    /**
     * يحدد حالة الدفع الحالية للطالب بالنسبة لجلسة التشفير النشطة:
     *  - no-session:    لا توجد جلسة تشفير نشطة حالياً لهذه المجموعة
     *  - not-attended:  الجلسة نشطة لكن الطالب لم يُسجَّل حضوره فيها بعد
     *  - paid:          تم الدفع بالفعل عن هذه الجلسة تحديدًا
     *  - pending:       يمكن تحصيل الدفع الآن
     */
    function getPendingSessionPayment(student) {
        const encId = getActiveEncryptionSessionId();
        if (!encId) return { status: 'no-session' };
        if (!isStudentInCurrentEncryptionSession(student)) return { status: 'not-attended', encId };
        if (hasPaidInEncryptionSession(student.id, encId)) return { status: 'paid', encId };
        return { status: 'pending', encId, fee: getStudentSessionFee(student) };
    }

    /** يُحدّث فوريًا أي مودال "تقرير أداء" مفتوح حاليًا لنفس الطالب — بدون إعادة تحميل الصفحة */
    function refreshOpenReportsForStudent(studentId) {
        // 1) تقرير الأداء الشامل العادي (report-modal) — لو كان مفتوحاً لنفس الطالب
        try {
            const reportModal = document.getElementById('report-modal');
            if (reportModal && reportModal.style.display === 'flex' &&
                typeof _currentReportState !== 'undefined' && _currentReportState.studentId == studentId &&
                typeof renderMonthlyReportBody === 'function') {
                renderMonthlyReportBody();
            }
        } catch (e) { /* تجاهل لو المتغيرات غير معرّفة بعد */ }

        // 2) تقرير أداء الحصة المستقل (session-report-modal) — لو كان مفتوحاً لنفس الطالب
        try {
            const sessReportModal = document.getElementById('session-report-modal');
            if (sessReportModal && sessReportModal.style.display === 'flex' && _sessionReportState.studentId == studentId) {
                openSessionPerformanceReport(studentId, _sessionReportState.periodId);
            }
        } catch (e) { /* تجاهل */ }
    }

    /** يُحدّث شاشة/مودال "الخزنة اليومية" فورًا لو كانا معروضين حاليًا — بدون إعادة تحميل الصفحة */
    function refreshTreasuryViews() {
        if (typeof renderDailyTreasury === 'function') {
            try { renderDailyTreasury(); } catch (e) { /* تجاهل لو الشاشة غير مفتوحة حاليًا */ }
        }
        if (typeof renderQuickDailyTreasuryModal === 'function') {
            try { renderQuickDailyTreasuryModal(); } catch (e) { /* تجاهل */ }
        }
    }

    /**
     * يُسجَّل من شاشة الحضور/المسح عند الضغط على زر "دفع" لجلسة التشفير النشطة.
     * مرة واحدة فقط لكل جلسة تشفير — وليس مرة واحدة في اليوم.
     */
    function payForAttendance(studentId) {
        ensureDataShape();
        const s = db.students.find(x => x.id == studentId);
        if (!s) return;

        const pending = getPendingSessionPayment(s);

        if (pending.status === 'no-session') {
            return showNotification('يرجى الضغط على "بدء تشفير الحصة" أولاً من شاشة الحضور قبل تحصيل الدفع', 'warning');
        }
        if (pending.status === 'not-attended') {
            return showNotification(`لم يتم تسجيل حضور ${s.name} في جلسة التشفير الحالية بعد. سجّل حضوره أولاً.`, 'warning');
        }
        if (pending.status === 'paid') {
            return showNotification('تم دفع هذه الحصة (لهذه الجلسة) بالفعل ✅', 'warning');
        }

        // نبحث عن سجل حضور اليوم فقط لربط الدفعة به لأغراض التقارير القديمة (بدون التأثير على منطق البوابة الجديد)
        const todayStr = new Date().toLocaleDateString('en-CA');
        const todayAtt = db.attendance.find(a => a.studentId == s.id && new Date(a.date).toLocaleDateString('en-CA') === todayStr);
        // ✅ إصلاح: نثبّت رقم جلسة التشفير على سجل الحضور نفسه (لو لم يكن مثبتاً بعد)
        // حتى تنجح المطابقة لاحقاً (hasLessonPayment) حتى لو تغيّر مصدر عرض الحصة
        if (todayAtt && !todayAtt.sessionId) todayAtt.sessionId = pending.encId;

        const fee = pending.fee;
        const period = getActiveSessionPeriod();

        const payment = {
            id: Date.now(),
            studentId: s.id,
            groupId: s.groupId,
            attendanceId: todayAtt ? todayAtt.id : null,
            encryptionSessionId: pending.encId,
            amount: fee,
            date: new Date().toISOString(),
            category: 'اشتراك بالحصة',
            periodId: period ? period.id : null
        };
        db.payments.push(payment);
        db.save('payments');

        showNotification(`تم تسجيل دفع الحصة (${fee} ج.م) لـ ${s.name} ✅`, 'success');

        if (typeof renderFinances === 'function') renderFinances();
        refreshTreasuryViews();
        if (typeof openSmartCard === 'function' && document.getElementById('smart-card-modal') &&
            document.getElementById('smart-card-modal').classList.contains('active')) {
            openSmartCard(s.id);
        }
        renderPanel();
        // ✅ تحديث فوري لأي تقرير أداء مفتوح لنفس الطالب (بدون إعادة تحميل الصفحة)
        refreshOpenReportsForStudent(s.id);
    }

    function undoSessionPayment(paymentId) {
        const idx = db.payments.findIndex(p => p.id == paymentId && p.category === 'اشتراك بالحصة');
        if (idx === -1) return;
        const pass = prompt('يرجى إدخال كلمة المرور لإلغاء تسجيل دفع الحصة:');
        const correct = (db._settings && db._settings.globalPasswords && db._settings.globalPasswords.unlockPayment) || '100qwe';
        if (pass !== correct) return showNotification('كلمة مرور غير صحيحة', 'error');
        const undoneStudentId = db.payments[idx].studentId;
        db.payments.splice(idx, 1);
        db.save('payments');
        showNotification('تم إلغاء دفع الحصة', 'warning');
        if (typeof renderFinances === 'function') renderFinances();
        refreshTreasuryViews();
        renderPanel();
        refreshOpenReportsForStudent(undoneStudentId);
    }

    // ──────────────────────────────────────────────────────
    //  5) عناصر بطاقة الطالب الذكية (Smart Card) — بديل أزرار الشهر
    // ──────────────────────────────────────────────────────
    function cardBorderColor(s) {
        return getPendingSessionPayment(s).status === 'pending' ? 'var(--danger)' : 'var(--accent)';
    }
    function cardTextColor(s) {
        return getPendingSessionPayment(s).status === 'pending' ? 'var(--danger)' : 'var(--accent)';
    }
    function cardStatusLabel(s) {
        const pending = getPendingSessionPayment(s);
        const fee = getStudentSessionFee(s);
        switch (pending.status) {
            case 'no-session':   return 'لا توجد جلسة تشفير نشطة الآن';
            case 'not-attended': return 'لم يُسجَّل حضوره في الجلسة الحالية بعد';
            case 'paid':         return 'تم دفع حصة هذه الجلسة ✅';
            default:              return `حصة هذه الجلسة غير مدفوعة (${fee} ج.م) ⏳`;
        }
    }

    function buildSmartCardButtons(s) {
        const pending = getPendingSessionPayment(s);
        if (pending.status !== 'pending') {
            const msg = {
                'no-session':   'ابدأ تشفير حصة جديدة أولاً',
                'not-attended': 'لم يُسجَّل حضوره في هذه الجلسة بعد',
                'paid':         'تم دفع حصة هذه الجلسة ✅'
            }[pending.status];
            return `
                <button class="btn" disabled style="height: 60px; border-radius: 12px; font-size: 0.95rem; background: var(--bg-light); color: var(--text-muted); border:1px dashed var(--border);">
                    <i class="fas fa-info-circle"></i> ${msg}
                </button>`;
        }
        return `
            <button class="btn btn-payment" style="height: 65px; border-radius: 12px; font-size: 0.95rem; background: #16a34a; box-shadow: 0 4px 14px -2px rgba(22,163,74,0.35);"
                onclick="SessionSub.payForAttendance(${s.id})">
                <i class="fas fa-hand-holding-usd" style="display:block;font-size:1.2rem;margin-bottom:3px;"></i>
                دفع هذه الحصة (${pending.fee} ج.م)
            </button>`;
    }

    // ──────────────────────────────────────────────────────
    //  6) تجميع حصص الطالب (حضور + غياب) في أي مدى زمني —
    //     بنفس منطق تقرير الأداء الشهري بالضبط (attendance +
    //     absenceSessions) حتى تتطابق الحصص الظاهرة في كل مكان.
    // ──────────────────────────────────────────────────────
    function collectStudentLessons(student, start, end) {
        const endBound = end || new Date(8640000000000000);

        const periodAtts = db.attendance.filter(a => {
            if (a.studentId != student.id) return false;
            const d = new Date(a.date);
            return d >= start && d < endBound;
        }).sort((a, b) => new Date(a.date) - new Date(b.date));

        const presentAtts = periodAtts.filter(a => a.status === 'present');
        const absentAtts = periodAtts.filter(a => a.status === 'absent');

        const sessionIdsInAttendance = new Set(
            periodAtts.filter(a => a.sessionId).map(a => String(a.sessionId))
        );

        const extraPresent = (db.absenceSessions || []).filter(sess => {
            const d = new Date(sess.date);
            if (d < start || d >= endBound) return false;
            if (sess.grade && String(sess.grade) !== String(student.grade)) return false;
            if (sess.groupId && String(sess.groupId) !== String(student.groupId)) return false;
            if (sessionIdsInAttendance.has(String(sess.id))) return false;
            return Array.isArray(sess.presentIds) && sess.presentIds.includes(student.id);
        });

        const extraAbsent = (db.absenceSessions || []).filter(sess => {
            const d = new Date(sess.date);
            if (d < start || d >= endBound) return false;
            if (sess.grade && String(sess.grade) !== String(student.grade)) return false;
            if (sess.groupId && String(sess.groupId) !== String(student.groupId)) return false;
            if (sessionIdsInAttendance.has(String(sess.id))) return false;
            return Array.isArray(sess.absentIds) && sess.absentIds.includes(student.id);
        });

        const present = [
            ...presentAtts,
            ...extraPresent.map(sess => ({ date: sess.date, status: 'present', sessionId: sess.id, _sessionName: sess.name }))
        ];
        const absent = [
            ...absentAtts,
            ...extraAbsent.map(sess => ({ date: sess.date, status: 'absent', sessionId: sess.id, _sessionName: sess.name }))
        ];

        return [...present, ...absent].sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    /** إحصائيات الحصص (لأي مدى زمني) — تُستخدم في تقرير الأداء الشهري ولوحة الخزينة */
    function computeStatsForRange(student, start, end) {
        const lessons = collectStudentLessons(student, start, end);
        const attended = lessons.filter(l => l.status === 'present');
        const payments = db.payments.filter(p => {
            if (p.studentId != student.id || p.category !== 'اشتراك بالحصة') return false;
            const d = new Date(p.date);
            const endBound = end || new Date(8640000000000000);
            return d >= start && d < endBound;
        });
        const paidCount = payments.length;
        // ✅ إصلاح: مطابقة كل حصة حضرها الطالب بدفعتها عبر hasLessonPayment
        // (attendanceId أو encryptionSessionId) بدل الاعتماد فقط على attendanceId
        // الذي لا يتوفر للحصص القادمة من db.absenceSessions.
        const unpaidAttended = attended.filter(a => !hasLessonPayment(student.id, a));
        const totalPaidAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const fee = getStudentSessionFee(student);
        const totalDueAmount = unpaidAttended.length * fee;

        return {
            attendedCount: attended.length,
            paidCount,
            unpaidCount: unpaidAttended.length,
            totalPaidAmount,
            totalDueAmount,
            fee,
            lessons,
            attended,
            payments,
            unpaidAttended
        };
    }

    /** نفس الدالة أعلاه لكن بمدخل "فترة حساب" (start/end رقمية) — تُستخدم في لوحة الخزينة */
    function computeSessionReport(student, period) {
        return computeStatsForRange(student, new Date(period.start), period.end != null ? new Date(period.end) : null);
    }

    /** صندوق الاشتراك داخل تقرير الأداء الشهري — بديل تام لصندوق "اشتراك الشهر" لكن بالحصة */
    function buildSubscriptionBoxHtml(student, start, end) {
        const stats = computeStatsForRange(student, start, end);

        let badgeHtml;
        if (stats.attendedCount === 0) {
            badgeHtml = `<span class="rep-badge rep-badge-muted">لا توجد حصص في هذه الفترة</span>`;
        } else if (stats.unpaidCount === 0) {
            badgeHtml = `<span class="rep-badge rep-badge-success">كل الحصص مسددة ✅</span>`;
        } else {
            badgeHtml = `<span class="rep-badge rep-badge-danger">${stats.unpaidCount} حصة غير مسددة ❌</span>`;
        }

        return `
            <div class="rep-subscription-box">
                <div class="rep-sub-row">
                    <span class="rep-sub-label"><i class="fas fa-wallet"></i> حالة الاشتراك بالحصة:</span>
                    ${badgeHtml}
                </div>
                <div class="rep-sub-row">
                    <span class="rep-sub-label"><i class="fas fa-list-ol"></i> عدد الحصص المدفوعة:</span>
                    <span>${stats.paidCount} من ${stats.attendedCount}</span>
                </div>
                <div class="rep-sub-row">
                    <span class="rep-sub-label"><i class="fas fa-coins"></i> المدفوع / المستحق:</span>
                    <span>${stats.totalPaidAmount} ج.م / ${stats.totalDueAmount} ج.م</span>
                </div>
                <div class="rep-sub-row">
                    <span class="rep-sub-label"><i class="fas fa-tag"></i> سعر الحصة الواحدة:</span>
                    <span>${stats.fee} ج.م</span>
                </div>
            </div>
        `;
    }

    /** نص حالة الاشتراك بالحصة لرسالة الواتساب */
    function buildWhatsAppSubStatus(student, start, end) {
        const stats = computeStatsForRange(student, start, end);
        if (stats.attendedCount === 0) return 'لا توجد حصص مسجلة في هذه الفترة';
        if (stats.unpaidCount === 0) return `تم سداد كل الحصص ✅ (${stats.totalPaidAmount} ج.م)`;
        return `${stats.paidCount} من ${stats.attendedCount} حصة مسددة — متبقي ${stats.unpaidCount} حصة (${stats.totalDueAmount} ج.م) ❌`;
    }

    // ──────────────────────────────────────────────────────
    //  7) أرشيف الحصص — لا يحذف أي بيانات، فقط "لقطة" دائمة
    //     تُحفظ عند إغلاق كل فترة حساب (بدء فترة جديدة / إنهاء الفترة)
    // ──────────────────────────────────────────────────────
    function archivePeriod(period) {
        ensureDataShape();
        // تجنّب الأرشفة المزدوجة لنفس الفترة
        if (db._settings.sessionArchive.some(a => a.id === period.id)) return;

        const start = new Date(period.start);
        const end = period.end != null ? new Date(period.end) : new Date();

        const sessionStudents = db.students.filter(isSessionStudent);
        const entries = [];

        sessionStudents.forEach(s => {
            const lessons = collectStudentLessons(s, start, end);
            if (lessons.length === 0) return;
            const group = db.groups.find(g => String(g.id) === String(s.groupId));
            lessons.forEach(l => {
                const attended = l.status === 'present';
                const paid = attended && hasLessonPayment(s.id, l);
                entries.push({
                    studentId: s.id,
                    studentName: s.name,
                    groupId: s.groupId,
                    groupName: group ? group.name : '---',
                    date: l.date,
                    attended,
                    paid,
                    notes: l._sessionName || ''
                });
            });
        });

        if (entries.length === 0) return; // لا داعي لأرشفة فترة فاضية

        db._settings.sessionArchive.push({
            id: period.id,
            label: period.label,
            start: period.start,
            end: period.end || Date.now(),
            createdAt: Date.now(),
            entries
        });
        persist();
    }

    function getAllArchivedPeriods() {
        ensureDataShape();
        return [...db._settings.sessionArchive].sort((a, b) => b.start - a.start);
    }

    /** يبني/يفتح مودال "أرشيف الحصص" — قائمة الفترات المؤرشفة */
    function openLessonsArchive() {
        ensureDataShape();
        ensureArchiveModal();
        const periods = getAllArchivedPeriods();
        const list = document.getElementById('session-archive-list-body');
        if (list) {
            list.innerHTML = periods.map(p => {
                const studentsCount = new Set(p.entries.map(e => e.studentId)).size;
                const lessonsCount = p.entries.length;
                return `
                    <tr style="border-bottom:1px solid #f1f5f9;">
                        <td style="padding:0.6rem; font-weight:700;">${p.label}</td>
                        <td style="text-align:center;">${new Date(p.start).toLocaleDateString('ar-EG')} — ${new Date(p.end).toLocaleDateString('ar-EG')}</td>
                        <td style="text-align:center;">${studentsCount}</td>
                        <td style="text-align:center;">${lessonsCount}</td>
                        <td style="text-align:left;">
                            <button class="btn btn-primary" style="background:#f59e0b; padding:5px 15px;" onclick="SessionSub.viewArchivedPeriod(${p.id})">
                                عرض التفاصيل <i class="fas fa-eye"></i>
                            </button>
                        </td>
                    </tr>
                `;
            }).join('') || `<tr><td colspan="5" style="text-align:center; padding:2rem; color:var(--text-muted);">لا يوجد فترات مؤرشفة بعد — الأرشفة تحدث تلقائيًا عند بدء فترة جديدة أو إنهاء الحالية</td></tr>`;
        }
        document.getElementById('session-archive-detail-wrap').style.display = 'none';
        document.getElementById('session-archive-list-wrap').style.display = 'block';
        toggleModal('session-archive-modal', true);
    }

    function viewArchivedPeriod(periodId, searchQuery = '') {
        ensureDataShape();
        const period = db._settings.sessionArchive.find(p => p.id == periodId);
        if (!period) return;

        document.getElementById('session-archive-list-wrap').style.display = 'none';
        const detailWrap = document.getElementById('session-archive-detail-wrap');
        detailWrap.style.display = 'block';

        const q = (searchQuery || '').trim().toLowerCase();
        let entries = [...period.entries].sort((a, b) => new Date(b.date) - new Date(a.date));
        if (q) entries = entries.filter(e => e.studentName.toLowerCase().includes(q) || e.groupName.toLowerCase().includes(q));

        detailWrap.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1rem;">
                <h4 style="margin:0;"><i class="fas fa-archive" style="color:#f59e0b;"></i> ${period.label}</h4>
                <div style="display:flex; gap:0.5rem; align-items:center;">
                    <input type="text" class="form-input" style="margin:0;" placeholder="بحث باسم الطالب أو المجموعة..."
                        value="${searchQuery.replace(/"/g, '&quot;')}"
                        oninput="SessionSub.viewArchivedPeriod(${period.id}, this.value)">
                    <button class="btn" onclick="SessionSub.backToArchiveList()"><i class="fas fa-arrow-right"></i> رجوع للأرشيف</button>
                </div>
            </div>
            <div style="overflow-x:auto; max-height:60vh; overflow-y:auto;">
                <table style="font-size:0.85rem; width:100%;">
                    <thead style="position:sticky; top:0; background:var(--bg-card, #fff); z-index:1;">
                        <tr>
                            <th>الطالب</th>
                            <th>المجموعة</th>
                            <th>التاريخ والوقت</th>
                            <th style="text-align:center;">الحضور</th>
                            <th style="text-align:center;">الدفع</th>
                            <th>ملاحظات</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${entries.map(e => `
                            <tr style="border-bottom:1px solid #f1f5f9; background:${e.attended ? (e.paid ? '#f0fdf4' : '#fff7ed') : '#fff1f2'};">
                                <td style="padding:0.5rem;">${e.studentName}</td>
                                <td>${e.groupName}</td>
                                <td style="font-size:0.8rem;">${new Date(e.date).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                <td style="text-align:center;">${e.attended ? '<span style="color:var(--accent);font-weight:700;">✅ حضر</span>' : '<span style="color:var(--danger);font-weight:700;">❌ غائب</span>'}</td>
                                <td style="text-align:center;">${e.paid ? '<span style="color:var(--accent);font-weight:700;">✅ مدفوعة</span>' : '<span style="color:var(--danger);font-weight:700;">❌ غير مدفوعة</span>'}</td>
                                <td style="font-size:0.8rem; color:var(--text-muted);">${e.notes || '---'}</td>
                            </tr>
                        `).join('') || `<tr><td colspan="6" style="text-align:center; padding:1.5rem; color:var(--text-muted);">لا توجد نتائج مطابقة</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;
    }

    function backToArchiveList() {
        document.getElementById('session-archive-detail-wrap').style.display = 'none';
        document.getElementById('session-archive-list-wrap').style.display = 'block';
    }

    // ──────────────────────────────────────────────────────
    //  7.1) أرشيف الحصص الفردية — سجل مستقل لكل "جلسة تشفير حصة"
    //       (كل ضغطة "بدء تشفير الحصة" ثم "إنهاء الجلسة" = حصة واحدة
    //       تُحفظ تلقائياً هنا بكل تفاصيلها، بنفس فكرة أرشيف الاشتراك
    //       الشهري لكن على مستوى الحصة الواحدة بدل الشهر).
    // ──────────────────────────────────────────────────────

    /**
     * يبني "لقطة" كاملة لجلسة التشفير الحالية (الحصة) ويحفظها في الأرشيف.
     * يُستدعى تلقائياً عند إنهاء الجلسة (endLessonCoding) قبل مسحها من
     * SessionManager — بدون أي تأثير على منطق الحضور/الدفع الأصلي.
     * @returns {object|null} سجل الأرشيف المحفوظ، أو null لو لا توجد جلسة/حضور
     */
    function archiveEncryptionSession() {
        ensureDataShape();
        const encId = getActiveEncryptionSessionId();
        if (!encId) return null;

        const sessionAttendance = (typeof SessionManager !== 'undefined') ? SessionManager.attendance() : [];
        if (!sessionAttendance.length) return null; // جلسة فارغة — لا داعي للأرشفة

        const attendedIds = new Set(sessionAttendance.map(x => x.id));
        const groupObj = db.groups.find(g => String(g.id) === String(currentGroupId));
        const logEntry = db._settings.encryptionSessionLog.find(l => l.id === encId);

        // كل طلاب "بالحصة" في نفس الصف/المجموعة — لعرض حالة كل طالب حتى لو لم يحضر
        const rosterStudents = db.students.filter(s =>
            String(s.grade) === String(currentGrade) &&
            String(s.groupId) === String(currentGroupId) &&
            isSessionStudent(s)
        );
        // ✅ نضمن ظهور كل من حضر فعلياً حتى لو تغيّر نوع اشتراكه لاحقاً
        const rosterIds = new Set(rosterStudents.map(s => s.id));
        const extraAttendees = sessionAttendance
            .filter(a => !rosterIds.has(a.id))
            .map(a => db.students.find(s => s.id === a.id))
            .filter(Boolean);
        const allStudents = [...rosterStudents, ...extraAttendees];

        const entries = allStudents.map(student => {
            const attended = attendedIds.has(student.id);
            const payment = attended
                ? db.payments.find(p => p.category === 'اشتراك بالحصة' && p.studentId == student.id && p.encryptionSessionId == encId)
                : null;
            return {
                studentId: student.id,
                studentName: student.name,
                attended,
                paid: !!payment,
                amount: payment ? (payment.amount || 0) : 0,
                paidAt: payment ? payment.date : null,
                notes: ''
            };
        });

        const paidCount = entries.filter(e => e.paid).length;
        const attendedEntries = entries.filter(e => e.attended);
        const totalCollected = entries.reduce((sum, e) => sum + (e.amount || 0), 0);

        const record = {
            id: encId,
            date: logEntry ? logEntry.startedAt : new Date().toISOString(),
            archivedAt: new Date().toISOString(),
            grade: String(currentGrade),
            groupId: String(currentGroupId),
            groupName: groupObj ? groupObj.name : '---',
            attendedCount: attendedEntries.length,
            paidCount,
            unpaidCount: attendedEntries.length - paidCount,
            totalCollected,
            entries
        };

        const existingIdx = db._settings.lessonSessionArchive.findIndex(r => r.id === encId);
        if (existingIdx > -1) {
            db._settings.lessonSessionArchive[existingIdx] = record;
        } else {
            db._settings.lessonSessionArchive.push(record);
        }
        persist();
        return record;
    }

    function getAllLessonSessionArchives() {
        ensureDataShape();
        return [...db._settings.lessonSessionArchive].sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    /** ينشئ مودال "أرشيف الحصص" الفردية مرة واحدة فقط لو مش موجود بالفعل */
    function ensureLessonArchiveModal() {
        if (document.getElementById('lesson-archive-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'lesson-archive-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:950px; width:95%;">
                <span class="close-btn" onclick="toggleModal('lesson-archive-modal', false)">&times;</span>
                <h2><i class="fas fa-layer-group" style="color:#f59e0b;"></i> أرشيف الحصص (لكل جلسة على حدة)</h2>
                <div id="lesson-archive-list-wrap">
                    <p style="color:var(--text-muted); margin-top:0.3rem;">كل حصة (جلسة تشفير) تُحفظ هنا تلقائياً عند إنهائها من شاشة الحضور والمسح</p>
                    <div style="overflow-x:auto; margin-top:1rem;">
                        <table style="width:100%; font-size:0.85rem;">
                            <thead>
                                <tr>
                                    <th>التاريخ والوقت</th>
                                    <th>المجموعة</th>
                                    <th style="text-align:center;">رقم جلسة التشفير</th>
                                    <th style="text-align:center;">حضروا</th>
                                    <th style="text-align:center;">دفعوا</th>
                                    <th style="text-align:center;">لم يدفعوا</th>
                                    <th style="text-align:center;">إجمالي المقبوضات</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody id="lesson-archive-list-body"></tbody>
                        </table>
                    </div>
                </div>
                <div id="lesson-archive-detail-wrap" style="display:none;"></div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    /** يفتح مودال أرشيف الحصص ويعرض قائمة كل الحصص المؤرشفة */
    function openLessonSessionsArchive() {
        ensureDataShape();
        ensureLessonArchiveModal();
        const records = getAllLessonSessionArchives();
        const list = document.getElementById('lesson-archive-list-body');
        if (list) {
            list.innerHTML = records.map(r => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:0.6rem; font-size:0.8rem;">${new Date(r.date).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>${r.groupName}</td>
                    <td style="text-align:center; font-family:monospace; font-size:0.75rem;">${r.id}</td>
                    <td style="text-align:center; color:var(--accent); font-weight:700;">${r.attendedCount}</td>
                    <td style="text-align:center; color:#16a34a; font-weight:700;">${r.paidCount}</td>
                    <td style="text-align:center; color:var(--danger); font-weight:700;">${r.unpaidCount}</td>
                    <td style="text-align:center; font-weight:800;">${r.totalCollected} ج.م</td>
                    <td style="text-align:left;">
                        <button class="btn btn-primary" style="background:#f59e0b; padding:5px 15px;" onclick="SessionSub.viewLessonSessionArchive(${r.id})">
                            عرض التفاصيل <i class="fas fa-eye"></i>
                        </button>
                    </td>
                </tr>
            `).join('') || `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-muted);">لا توجد حصص مؤرشفة بعد — تُحفظ كل حصة تلقائياً عند إنهاء جلسة التشفير الخاصة بها من شاشة الحضور والمسح</td></tr>`;
        }
        document.getElementById('lesson-archive-detail-wrap').style.display = 'none';
        document.getElementById('lesson-archive-list-wrap').style.display = 'block';
        toggleModal('lesson-archive-modal', true);
    }

    /** يعرض تفاصيل حصة واحدة من الأرشيف: أسماء الطلاب، الحضور، الدفع، الوقت، الملاحظات — مع إمكانية التعديل */
    function viewLessonSessionArchive(archiveId, searchQuery = '') {
        ensureDataShape();
        const record = db._settings.lessonSessionArchive.find(r => r.id == archiveId);
        if (!record) return;

        document.getElementById('lesson-archive-list-wrap').style.display = 'none';
        const detailWrap = document.getElementById('lesson-archive-detail-wrap');
        detailWrap.style.display = 'block';

        const q = (searchQuery || '').trim().toLowerCase();
        let entries = [...record.entries];
        if (q) entries = entries.filter(e => e.studentName.toLowerCase().includes(q));

        detailWrap.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1rem;">
                <div>
                    <h4 style="margin:0;"><i class="fas fa-calendar-day" style="color:#f59e0b;"></i> حصة ${record.groupName} — ${new Date(record.date).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</h4>
                    <span style="font-size:0.78rem; color:var(--text-muted); font-family:monospace;">رقم جلسة التشفير: ${record.id}</span>
                </div>
                <div style="display:flex; gap:0.5rem; align-items:center;">
                    <input type="text" class="form-input" style="margin:0;" placeholder="بحث باسم الطالب..."
                        value="${searchQuery.replace(/"/g, '&quot;')}"
                        oninput="SessionSub.viewLessonSessionArchive(${record.id}, this.value)">
                    <button class="btn" onclick="SessionSub.backToLessonArchiveList()"><i class="fas fa-arrow-right"></i> رجوع للأرشيف</button>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:0.75rem; margin-bottom:1rem;">
                <div class="card" style="padding:0.75rem; text-align:center; border-bottom:3px solid var(--accent);">
                    <div style="font-size:0.75rem; color:var(--text-muted);">حضروا</div>
                    <div style="font-size:1.2rem; font-weight:800; color:var(--accent);">${record.attendedCount}</div>
                </div>
                <div class="card" style="padding:0.75rem; text-align:center; border-bottom:3px solid #16a34a;">
                    <div style="font-size:0.75rem; color:var(--text-muted);">دفعوا</div>
                    <div style="font-size:1.2rem; font-weight:800; color:#16a34a;">${record.paidCount}</div>
                </div>
                <div class="card" style="padding:0.75rem; text-align:center; border-bottom:3px solid var(--danger);">
                    <div style="font-size:0.75rem; color:var(--text-muted);">لم يدفعوا</div>
                    <div style="font-size:1.2rem; font-weight:800; color:var(--danger);">${record.unpaidCount}</div>
                </div>
                <div class="card" style="padding:0.75rem; text-align:center; border-bottom:3px solid #f59e0b;">
                    <div style="font-size:0.75rem; color:var(--text-muted);">إجمالي المقبوضات</div>
                    <div style="font-size:1.2rem; font-weight:800; color:#f59e0b;">${record.totalCollected} ج.م</div>
                </div>
            </div>

            <div style="overflow-x:auto; max-height:55vh; overflow-y:auto;">
                <table style="font-size:0.85rem; width:100%;">
                    <thead style="position:sticky; top:0; background:var(--bg-card, #fff); z-index:1;">
                        <tr>
                            <th>الطالب</th>
                            <th style="text-align:center;">الحضور</th>
                            <th style="text-align:center;">الدفع</th>
                            <th style="text-align:center;">القيمة</th>
                            <th>وقت الدفع</th>
                            <th>ملاحظات</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${entries.map(e => `
                            <tr style="border-bottom:1px solid #f1f5f9; background:${e.attended ? (e.paid ? '#f0fdf4' : '#fff7ed') : '#fff1f2'};">
                                <td style="padding:0.5rem; font-weight:700;">${e.studentName}</td>
                                <td style="text-align:center;">${e.attended ? '<span style="color:var(--accent);font-weight:700;">✅ حضر</span>' : '<span style="color:var(--danger);font-weight:700;">❌ غائب</span>'}</td>
                                <td style="text-align:center;">${e.paid ? '<span style="color:#16a34a;font-weight:700;">✅ مدفوعة</span>' : (e.attended ? '<span style="color:var(--danger);font-weight:700;">❌ غير مدفوعة</span>' : '<span style="color:var(--text-muted);">---</span>')}</td>
                                <td style="text-align:center;">${e.amount ? e.amount + ' ج.م' : '---'}</td>
                                <td style="font-size:0.78rem;">${e.paidAt ? new Date(e.paidAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '---'}</td>
                                <td>
                                    <input type="text" class="form-input" style="margin:0; font-size:0.78rem; padding:0.4rem;" value="${(e.notes || '').replace(/"/g, '&quot;')}"
                                        placeholder="أضف ملاحظة..."
                                        onchange="SessionSub.updateArchivedLessonNote(${record.id}, ${e.studentId}, this.value)">
                                </td>
                                <td style="text-align:left;">
                                    ${e.attended ? `
                                        <button class="btn" style="padding:4px 10px; font-size:0.75rem; background:${e.paid ? 'var(--bg-light)' : '#16a34a'}; color:${e.paid ? 'var(--danger)' : '#fff'};"
                                            onclick="SessionSub.toggleArchivedLessonPayment(${record.id}, ${e.studentId})">
                                            ${e.paid ? 'إلغاء الدفع' : 'تسجيل دفع'}
                                        </button>
                                    ` : ''}
                                </td>
                            </tr>
                        `).join('') || `<tr><td colspan="7" style="text-align:center; padding:1.5rem; color:var(--text-muted);">لا توجد نتائج مطابقة</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;
    }

    function backToLessonArchiveList() {
        document.getElementById('lesson-archive-detail-wrap').style.display = 'none';
        document.getElementById('lesson-archive-list-wrap').style.display = 'block';
        openLessonSessionsArchive(); // إعادة بناء القائمة لعكس أي تعديلات حدثت
    }

    /** يحدّث نص الملاحظة الخاصة بطالب داخل حصة مؤرشفة (بدون أي تأثير على الدفع) */
    function updateArchivedLessonNote(archiveId, studentId, note) {
        ensureDataShape();
        const record = db._settings.lessonSessionArchive.find(r => r.id == archiveId);
        if (!record) return;
        const entry = record.entries.find(e => e.studentId == studentId);
        if (!entry) return;
        entry.notes = note || '';
        persist();
    }

    /**
     * يعدّل حالة دفع طالب داخل حصة مؤرشفة (تسجيل دفع / إلغاء دفع)، وينشئ أو
     * يحذف سجل الدفعة الفعلي في db.payments بحيث ينعكس التعديل تلقائياً على:
     *  - تقرير الأداء (يُعاد حسابه من db.payments مباشرة)
     *  - إحصائيات لوحة الاشتراك بالحصة
     *  - العهدة اليومية (لو التعديل يخص دفعة بتاريخ اليوم)
     *  - إجمالي مقبوضات الحصة نفسها داخل الأرشيف
     */
    function toggleArchivedLessonPayment(archiveId, studentId) {
        ensureDataShape();
        const record = db._settings.lessonSessionArchive.find(r => r.id == archiveId);
        if (!record) return;
        const entry = record.entries.find(e => e.studentId == studentId);
        if (!entry) return;
        if (!entry.attended) return showNotification('لا يمكن تسجيل دفع لطالب لم يحضر هذه الحصة', 'warning');

        if (entry.paid) {
            // ── إلغاء دفع موجود: يتطلب كلمة مرور مثل باقي عمليات إلغاء الدفع بالنظام ──
            const pass = prompt('يرجى إدخال كلمة المرور لإلغاء تسجيل دفع هذه الحصة:');
            const correct = (db._settings && db._settings.globalPasswords && db._settings.globalPasswords.unlockPayment) || '100qwe';
            if (pass !== correct) return showNotification('كلمة مرور غير صحيحة', 'error');

            const idx = db.payments.findIndex(p =>
                p.category === 'اشتراك بالحصة' && p.studentId == studentId && p.encryptionSessionId == archiveId
            );
            if (idx > -1) db.payments.splice(idx, 1);
            db.save('payments');

            entry.paid = false;
            entry.amount = 0;
            entry.paidAt = null;
            showNotification('تم إلغاء تسجيل الدفع لهذه الحصة', 'warning');
        } else {
            // ── تسجيل دفع جديد لهذا الطالب في هذه الحصة تحديداً ──
            const student = db.students.find(s => s.id == studentId);
            if (!student) return;
            const fee = getStudentSessionFee(student);
            const period = getActiveSessionPeriod();
            const payment = {
                id: Date.now(),
                studentId: studentId,
                groupId: record.groupId,
                attendanceId: null,
                encryptionSessionId: archiveId,
                amount: fee,
                date: new Date().toISOString(),
                category: 'اشتراك بالحصة',
                periodId: period ? period.id : null
            };
            db.payments.push(payment);
            db.save('payments');

            entry.paid = true;
            entry.amount = fee;
            entry.paidAt = payment.date;
            showNotification(`تم تسجيل دفع الحصة (${fee} ج.م) لـ ${student.name} ✅`, 'success');
        }

        // ── إعادة حساب إجماليات سجل هذه الحصة داخل الأرشيف ──
        record.paidCount = record.entries.filter(e => e.paid).length;
        record.unpaidCount = record.entries.filter(e => e.attended && !e.paid).length;
        record.totalCollected = record.entries.reduce((sum, e) => sum + (e.amount || 0), 0);
        persist();

        // ── تحديث تسلسلي لكل الشاشات المتأثرة، فوراً وبدون إعادة تحميل الصفحة ──
        if (typeof renderFinances === 'function') renderFinances();
        refreshTreasuryViews();  // العهدة اليومية (لو التعديل بتاريخ اليوم)
        renderPanel();           // إحصائيات لوحة الاشتراك بالحصة
        refreshOpenReportsForStudent(studentId); // تقرير الأداء المفتوح لنفس الطالب

        // ── إعادة رسم تفاصيل الحصة نفسها لتعكس التعديل فوراً ──
        viewLessonSessionArchive(archiveId);
    }


    function ensureArchiveModal() {
        if (document.getElementById('session-archive-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'session-archive-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:900px; width:95%;">
                <span class="close-btn" onclick="toggleModal('session-archive-modal', false)">&times;</span>
                <h2><i class="fas fa-archive" style="color:#f59e0b;"></i> أرشيف الحصص</h2>
                <div id="session-archive-list-wrap">
                    <p style="color:var(--text-muted); margin-top:0.3rem;">كل فترات الاشتراك بالحصة السابقة (لا يمكن حذف أو تعديل بياناتها — للعرض والمراجعة فقط)</p>
                    <div style="overflow-x:auto; margin-top:1rem;">
                        <table style="width:100%; font-size:0.85rem;">
                            <thead>
                                <tr>
                                    <th>الفترة</th>
                                    <th style="text-align:center;">المدة</th>
                                    <th style="text-align:center;">عدد الطلاب</th>
                                    <th style="text-align:center;">عدد الحصص</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody id="session-archive-list-body"></tbody>
                        </table>
                    </div>
                </div>
                <div id="session-archive-detail-wrap" style="display:none;"></div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    // ──────────────────────────────────────────────────────
    //  8) لوحة إدارة الاشتراك بالحصة داخل "الخزينة والمالية"
    // ──────────────────────────────────────────────────────
    function ensurePanelContainer() {
        let el = document.getElementById('session-subscription-panel');
        if (el) return el;
        const anchor = document.getElementById('monthly-tables');
        if (!anchor || !anchor.parentElement) return null;
        el = document.createElement('div');
        el.id = 'session-subscription-panel';
        el.className = 'data-table-container';
        el.style.marginTop = '2rem';
        el.style.borderTop = '5px solid #f59e0b';
        anchor.parentElement.appendChild(el);
        return el;
    }

    /** يعرض مؤشر واضح في شاشة الحضور والمسح بالوضع الحالي للنظام (شهري / بالحصة) */
    function renderModeIndicator() {
        const el = document.getElementById('session-mode-indicator');
        if (!el) return;
        ensureDataShape();

        if (isGlobalSessionModeActive()) {
            el.style.display = 'block';
            el.innerHTML = `
                <span class="status-badge" style="background:#fff7ed; color:#b45309; padding:0.6rem 1.5rem; font-size:1rem; border:2px solid #fde68a; font-weight:800;">
                    <i class="fas fa-coins"></i> الوضع الحالي: اشتراك الحصة (مفعّل لجميع الطلاب)
                </span>`;
            return;
        }

        const groupHasSessionStudents = db.students.some(s =>
            String(s.grade) === String(currentGrade) &&
            String(s.groupId) === String(currentGroupId) &&
            isSessionStudent(s)
        );
        if (groupHasSessionStudents) {
            el.style.display = 'block';
            el.innerHTML = `
                <span class="status-badge" style="background:#fff7ed; color:#b45309; padding:0.6rem 1.5rem; font-size:0.9rem; border:2px solid #fde68a; font-weight:700;">
                    <i class="fas fa-coins"></i> بعض طلاب هذه المجموعة على "اشتراك بالحصة"
                </span>`;
            return;
        }

        el.style.display = 'none';
        el.innerHTML = '';
    }

    function renderPanel() {
        ensureDataShape();
        const panel = ensurePanelContainer();
        if (!panel) return; // شاشة الإدارة المالية غير مفتوحة حالياً

        if (typeof currentGrade === 'undefined' || typeof currentGroupId === 'undefined') return;

        const groupStudents = db.students.filter(s =>
            String(s.grade) === String(currentGrade) && String(s.groupId) === String(currentGroupId)
        );
        const sessionStudents = groupStudents.filter(isSessionStudent);
        const monthlyStudents = groupStudents.filter(s => !isSessionStudent(s));

        const fee = getGroupSessionFee(currentGroupId);
        const activePeriod = getActiveSessionPeriod();
        const periods = getAllSessionPeriods();
        const isGlobalActive = isGlobalSessionModeActive();

        // ✅ إجمالي مقبوضات الحصة لهذه المجموعة: الفترة الحالية + كل الأوقات
        const periodForTotals = activePeriod || { start: 0, end: null };
        const currentPeriodTotal = sessionStudents.reduce((sum, s) => {
            const stats = computeSessionReport(s, periodForTotals);
            return sum + stats.totalPaidAmount;
        }, 0);

        const groupSessionPayments = db.payments.filter(p =>
            p.category === 'اشتراك بالحصة' && String(p.groupId) === String(currentGroupId)
        );
        const allTimeSessionTotal = groupSessionPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const paidStudentsCount = new Set(groupSessionPayments.map(p => p.studentId)).size;
        const avgSessionIncome = groupSessionPayments.length
            ? Math.round(allTimeSessionTotal / groupSessionPayments.length)
            : 0;
        const totalSessionsExecuted = db._settings.encryptionSessionLog.filter(l =>
            String(l.groupId) === String(currentGroupId)
        ).length;

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const yearStart = new Date(now.getFullYear(), 0, 1);
        const monthlySessionIncome = groupSessionPayments
            .filter(p => new Date(p.date) >= monthStart)
            .reduce((sum, p) => sum + (p.amount || 0), 0);
        const yearlySessionIncome = groupSessionPayments
            .filter(p => new Date(p.date) >= yearStart)
            .reduce((sum, p) => sum + (p.amount || 0), 0);

        const rows = sessionStudents.map(s => {
            const period = activePeriod || { start: 0, end: null };
            const stats = computeSessionReport(s, period);
            return `
                <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:0.5rem;"><strong>${s.name}</strong></td>
                    <td style="text-align:center;">${stats.attendedCount}</td>
                    <td style="text-align:center; color:var(--accent);">${stats.paidCount}</td>
                    <td style="text-align:center; color:var(--danger);">${stats.unpaidCount}</td>
                    <td style="text-align:center; font-weight:700;">${stats.totalDueAmount} ج.م</td>
                    <td style="text-align:left;">
                        <select class="form-input" style="margin:0; width:auto; font-size:0.75rem;" onchange="SessionSub.setStudentSubscriptionMode(${s.id}, this.value)">
                            <option value="session" selected>بالحصة</option>
                            <option value="monthly">شهري</option>
                        </select>
                    </td>
                </tr>
            `;
        }).join('') || `<tr><td colspan="6" style="text-align:center; padding:1rem; color:var(--text-muted);">لا يوجد طلاب مشتركين بالحصة في هذه المجموعة</td></tr>`;

        const monthlyModeRows = monthlyStudents.map(s => `
            <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:0.5rem;">${s.name}</td>
                <td style="text-align:left;">
                    <select class="form-input" style="margin:0; width:auto; font-size:0.75rem;" onchange="SessionSub.setStudentSubscriptionMode(${s.id}, this.value)">
                        <option value="monthly" selected>شهري</option>
                        <option value="session">بالحصة</option>
                    </select>
                </td>
            </tr>
        `).join('');

        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
                <h3 style="margin:0;"><i class="fas fa-coins" style="color:#f59e0b;"></i> إدارة الاشتراك بالحصة (مستقل عن الاشتراك الشهري)</h3>
                <button class="btn" style="background:#334155; color:#fff;" onclick="SessionSub.openLessonsArchive()">
                    <i class="fas fa-archive"></i> أرشيف فترات الحساب
                </button>
                <button class="btn" style="background:#f59e0b; color:#fff;" onclick="SessionSub.openLessonSessionsArchive()">
                    <i class="fas fa-layer-group"></i> أرشيف الحصص (لكل حصة)
                </button>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-top:1rem; padding:1rem; background:${isGlobalActive ? '#fff7ed' : 'var(--bg-light)'}; border-radius:12px; border:2px solid ${isGlobalActive ? '#f59e0b' : 'transparent'};">
                <div>
                    <strong style="display:block; margin-bottom:0.3rem;"><i class="fas fa-toggle-on"></i> تفعيل الاشتراك بالحصة لجميع الطلاب دفعة واحدة</strong>
                    <span style="font-size:0.8rem; color:var(--text-muted);">عند التفعيل: يتحول كل طالب في النظام تلقائيًا لاشتراك بالحصة. عند الإلغاء: يعودون جميعًا للاشتراك الشهري.</span>
                </div>
                <label style="display:flex; align-items:center; gap:0.6rem; cursor:pointer; font-weight:700;">
                    <span>${isGlobalActive ? 'مفعّل لجميع الطلاب ✅' : 'غير مفعّل (وضع فردي)'}</span>
                    <input type="checkbox" id="session-global-toggle" ${isGlobalActive ? 'checked' : ''}
                        onchange="SessionSub.setGlobalSessionMode(this.checked)"
                        style="width:44px; height:24px; cursor:pointer;">
                </label>
            </div>

            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap:1rem; margin-top:1rem;">
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid #f59e0b; background:#fffbeb;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">إجمالي المقبوضات بالحصة</div>
                    <div style="font-size:1.4rem; font-weight:800; color:#f59e0b;">${allTimeSessionTotal} <small>ج.م</small></div>
                </div>
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid var(--accent); background:#f0fdf4;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">عدد الطلاب الذين دفعوا بالحصة</div>
                    <div style="font-size:1.4rem; font-weight:800; color:var(--accent);">${paidStudentsCount}</div>
                </div>
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid #0ea5e9; background:#f0f9ff;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">متوسط دخل الحصة</div>
                    <div style="font-size:1.4rem; font-weight:800; color:#0ea5e9;">${avgSessionIncome} <small>ج.م</small></div>
                </div>
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid #7c3aed; background:#f5f3ff;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">إجمالي عدد الحصص المنفذة</div>
                    <div style="font-size:1.4rem; font-weight:800; color:#7c3aed;">${totalSessionsExecuted}</div>
                </div>
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid #16a34a; background:#f0fdf4;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">إيرادات الحصة هذا الشهر</div>
                    <div style="font-size:1.4rem; font-weight:800; color:#16a34a;">${monthlySessionIncome} <small>ج.م</small></div>
                </div>
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid var(--primary); background:#f5f3ff;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">إيرادات الحصة هذا العام</div>
                    <div style="font-size:1.4rem; font-weight:800; color:var(--primary);">${yearlySessionIncome} <small>ج.م</small></div>
                </div>
                <div class="card" style="padding:1rem; text-align:center; border-bottom:4px solid #f59e0b; background:#fffbeb;">
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">مقبوضات الفترة الحالية</div>
                    <div style="font-size:1.4rem; font-weight:800; color:#f59e0b;">${currentPeriodTotal} <small>ج.م</small></div>
                </div>
            </div>

            <div style="display:flex; gap:1.5rem; flex-wrap:wrap; align-items:flex-end; margin-top:1rem; padding:1rem; background:var(--bg-light); border-radius:12px;">
                <div style="flex:1; min-width:150px;">
                    <label style="display:block; margin-bottom:0.5rem; font-weight:700;">سعر الحصة الواحدة لهذه المجموعة (ج.م):</label>
                    <input type="number" id="session-fee-input" class="form-input" style="margin-bottom:0;" value="${fee}" placeholder="مثلاً: 20">
                </div>
                <button class="btn btn-primary" style="background:#f59e0b;" onclick="SessionSub.setGroupSessionFee(currentGroupId, document.getElementById('session-fee-input').value)">
                    <i class="fas fa-save"></i> حفظ سعر الحصة
                </button>
            </div>

            <div style="display:flex; gap:1.5rem; flex-wrap:wrap; align-items:center; margin-top:1rem; padding:1rem; background:var(--bg-light); border-radius:12px;">
                <div style="flex:1; min-width:220px;">
                    <strong>فترة الحساب الحالية (بالحصة):</strong>
                    <div style="margin-top:0.3rem;">
                        ${activePeriod
                            ? `<span class="status-badge" style="background:#dcfce7; color:#166534;">${activePeriod.label} (نشطة الآن)</span>`
                            : `<span class="status-badge" style="background:#fee2e2; color:var(--danger);">لا توجد فترة حساب نشطة حالياً</span>`}
                    </div>
                </div>
                <button class="btn" style="background:#16a34a; color:#fff;" onclick="SessionSub.promptStartPeriod()">
                    <i class="fas fa-play"></i> بدء فترة جديدة (مثل: ترم جديد)
                </button>
                ${activePeriod ? `
                <button class="btn" style="background:var(--danger); color:#fff;" onclick="SessionSub.endActiveSessionPeriod()">
                    <i class="fas fa-stop"></i> إنهاء الفترة الحالية
                </button>` : ''}
                ${periods.length ? `<span style="color:var(--text-muted); font-size:0.85rem;">(عدد الفترات السابقة المؤرشفة: ${periods.filter(p => p.end).length})</span>` : ''}
            </div>

            <div style="overflow-x:auto; margin-top:1.5rem;">
                <table style="font-size:0.85rem; width:100%;">
                    <thead>
                        <tr>
                            <th>الطالب</th>
                            <th style="text-align:center;">حصص حضرها (الفترة)</th>
                            <th style="text-align:center;">مدفوعة</th>
                            <th style="text-align:center;">غير مسددة</th>
                            <th style="text-align:center;">إجمالي المستحق</th>
                            <th style="text-align:left;">نوع الاشتراك</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>

            ${monthlyStudents.length ? `
            <details style="margin-top:1.5rem;">
                <summary style="cursor:pointer; font-weight:700; color:var(--text-muted);">تغيير نوع اشتراك باقي طلاب المجموعة (شهريين حالياً)</summary>
                <div style="overflow-x:auto; margin-top:0.75rem;">
                    <table style="font-size:0.85rem; width:100%;">
                        <tbody>${monthlyModeRows}</tbody>
                    </table>
                </div>
            </details>` : ''}
        `;
    }

    function promptStartPeriod() {
        const label = prompt('اسم فترة الحساب الجديدة (مثال: الترم الأول 2026):', '');
        if (label === null) return; // المستخدم ألغى
        startNewSessionPeriod(label);
    }

    // ──────────────────────────────────────────────────────
    //  10) تقرير أداء الحصة — تقرير مستقل بالكامل عن تقرير الأداء
    //      الشهري (مودال خاص به)، بديل كامل له لطلاب "بالحصة" فقط.
    // ──────────────────────────────────────────────────────
    function ensureSessionReportModal() {
        if (document.getElementById('session-report-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'session-report-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:800px; width:95%; max-height:92vh; overflow-y:auto;">
                <span class="close-btn" onclick="toggleModal('session-report-modal', false)">&times;</span>
                <div id="session-report-body"></div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    let _sessionReportState = { studentId: null, periodId: 'current' };

    /** تُستدعى تلقائيًا بدل تقرير الأداء الشهري لأي طالب "بالحصة" */
    function openSessionPerformanceReport(studentId, periodId = null) {
        ensureDataShape();
        const s = db.students.find(x => x.id == studentId);
        if (!s) return;

        ensureSessionReportModal();

        // ── بناء قائمة الفترات: الفترة الحالية (لو موجودة) + كل الفترات المؤرشفة ──
        const activePeriod = getActiveSessionPeriod();
        const archived = getAllArchivedPeriods();
        const periodOptions = [];
        if (activePeriod) periodOptions.push({ id: 'current', label: `${activePeriod.label} (الفترة الحالية)`, start: activePeriod.start, end: null });
        archived.forEach(p => periodOptions.push({ id: String(p.id), label: p.label, start: p.start, end: p.end }));
        if (periodOptions.length === 0) periodOptions.push({ id: 'all', label: 'كل الوقت (لا توجد فترات محدَّدة بعد)', start: 0, end: null });

        let chosenId = periodId != null ? String(periodId) : (_sessionReportState.studentId === studentId ? String(_sessionReportState.periodId) : String(periodOptions[0].id));
        if (!periodOptions.some(p => String(p.id) === chosenId)) chosenId = String(periodOptions[0].id);
        _sessionReportState = { studentId, periodId: chosenId };

        const chosen = periodOptions.find(p => String(p.id) === chosenId);
        const start = new Date(chosen.start);
        const end = chosen.end != null ? new Date(chosen.end) : null;

        const stats = computeStatsForRange(s, start, end);
        const group = db.groups.find(g => String(g.id) === String(s.groupId));
        const profile = (typeof getProgramProfile === 'function') ? getProgramProfile() : { teacherName: 'مستر محمد السيد' };

        const lessonsRowsHtml = stats.lessons.length === 0
            ? `<tr><td colspan="3" style="text-align:center; padding:1.5rem; color:var(--text-muted);">لا توجد حصص مسجلة في هذه الفترة</td></tr>`
            : stats.lessons.map((l, i) => {
                const attended = l.status === 'present';
                const paid = attended && hasLessonPayment(s.id, l);
                const dateStr = new Date(l.date).toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'numeric' });
                return `
                    <tr style="background:${attended ? (paid ? '#f0fdf4' : '#fff7ed') : '#fff1f2'};">
                        <td style="padding:8px 12px; font-weight:700;">الحصة ${i + 1} <span style="color:var(--text-muted); font-weight:400; font-size:0.78rem;">(${dateStr})</span></td>
                        <td style="padding:8px 12px; text-align:center;">${attended ? '<span style="color:var(--accent); font-weight:700;">✅ حضر</span>' : '<span style="color:var(--danger); font-weight:700;">❌ غائب</span>'}</td>
                        <td style="padding:8px 12px; text-align:center;">${paid ? '<span style="color:var(--accent); font-weight:700;">✅ مدفوعة</span>' : '<span style="color:var(--danger); font-weight:700;">❌ غير مدفوعة</span>'}</td>
                    </tr>
                `;
            }).join('');

        const body = document.getElementById('session-report-body');
        body.innerHTML = `
            <div style="text-align:center; margin-bottom:1rem;">
                <div style="font-size:1.4rem; font-weight:900; color:#f59e0b;"><i class="fas fa-coins"></i> تقرير أداء الحصة</div>
                <div style="color:var(--text-muted); font-size:0.9rem;">المدرّس: ${profile.teacherName || 'مستر محمد السيد'}</div>
            </div>

            <div class="rep-subscription-box" style="margin-bottom:1rem;">
                <div class="rep-sub-row"><span class="rep-sub-label"><i class="fas fa-user"></i> الطالب:</span><span><strong>${s.name}</strong></span></div>
                <div class="rep-sub-row"><span class="rep-sub-label"><i class="fas fa-qrcode"></i> الكود:</span><span>${s.qrCode || '---'}</span></div>
                <div class="rep-sub-row"><span class="rep-sub-label"><i class="fas fa-layer-group"></i> المجموعة:</span><span>${group ? group.name : '---'}</span></div>
            </div>

            <div style="text-align:center; margin-bottom:1rem;">
                <select class="form-input" style="margin:0 auto; width:auto; min-width:220px; text-align:center; font-weight:700;"
                    onchange="SessionSub.openSessionPerformanceReport(${s.id}, this.value)">
                    ${periodOptions.map(p => `<option value="${p.id}" ${String(p.id) === chosenId ? 'selected' : ''}>${p.label}</option>`).join('')}
                </select>
            </div>

            <div class="rep-summary-grid" style="margin-bottom:1rem;">
                <div class="rep-stat-card rep-stat-accent">
                    <div class="rep-stat-icon"><i class="fas fa-calendar-check"></i></div>
                    <div class="rep-stat-value">${stats.attendedCount}</div>
                    <div class="rep-stat-label">حصص حضرها</div>
                </div>
                <div class="rep-stat-card rep-stat-primary">
                    <div class="rep-stat-icon"><i class="fas fa-hand-holding-usd"></i></div>
                    <div class="rep-stat-value">${stats.paidCount}</div>
                    <div class="rep-stat-label">حصص مدفوعة</div>
                </div>
                <div class="rep-stat-card rep-stat-danger">
                    <div class="rep-stat-icon"><i class="fas fa-exclamation-circle"></i></div>
                    <div class="rep-stat-value">${stats.unpaidCount}</div>
                    <div class="rep-stat-label">غير مسددة</div>
                </div>
                <div class="rep-stat-card rep-stat-warning">
                    <div class="rep-stat-icon"><i class="fas fa-coins"></i></div>
                    <div class="rep-stat-value">${stats.totalDueAmount} ج.م</div>
                    <div class="rep-stat-label">إجمالي المستحق</div>
                </div>
            </div>

            <div style="overflow-x:auto;">
                <table style="width:100%; font-size:0.9rem;">
                    <thead>
                        <tr>
                            <th>الحصة</th>
                            <th style="text-align:center;">الحضور</th>
                            <th style="text-align:center;">الدفع</th>
                        </tr>
                    </thead>
                    <tbody>${lessonsRowsHtml}</tbody>
                </table>
            </div>

            <div style="text-align:center; margin-top:1.5rem;">
                <button class="btn" style="background:#25d366; color:#fff;" onclick="SessionSub.sendSessionReportWhatsApp(${s.id})">
                    <i class="fab fa-whatsapp"></i> إرسال التقرير لولي الأمر
                </button>
            </div>
        `;

        toggleModal('session-report-modal', true);
    }

    function sendSessionReportWhatsApp(studentId) {
        const s = db.students.find(x => x.id == studentId);
        if (!s) return;
        if (!s.parentPhone) return showNotification('رقم ولي الأمر غير مسجل لهذا الطالب', 'warning');

        const periodId = _sessionReportState.studentId === studentId ? _sessionReportState.periodId : 'current';
        const activePeriod = getActiveSessionPeriod();
        let start, end, label;
        if (periodId === 'current' && activePeriod) {
            start = new Date(activePeriod.start); end = null; label = activePeriod.label;
        } else if (periodId === 'all' || !activePeriod) {
            start = new Date(0); end = null; label = 'كل الوقت';
        } else {
            const p = db._settings.sessionArchive.find(x => String(x.id) === String(periodId));
            start = p ? new Date(p.start) : new Date(0);
            end = p ? new Date(p.end) : null;
            label = p ? p.label : 'كل الوقت';
        }

        const statusText = buildWhatsAppSubStatus(s, start, end);
        const msg = `السلام عليكم ورحمة الله وبركاته،\n\n📌 *تقرير أداء الحصة — ${label}*\nالطالب: ${s.name}\n${statusText}${(typeof getTeacherSignatureLine === 'function') ? getTeacherSignatureLine() : ''}`;

        if (typeof sendWhatsAppNotification === 'function') {
            sendWhatsAppNotification({
                studentId: s.id,
                phone: s.parentPhone,
                message: msg,
                noticeType: `تقرير أداء الحصة — ${label}`
            });
        } else if (typeof window.open === 'function') {
            const phone = String(s.parentPhone).replace(/\D/g, '');
            window.open(`https://wa.me/2${phone}?text=${encodeURIComponent(msg)}`, '_blank');
        }
    }

    // ──────────────────────────────────────────────────────
    //  11) ربط تلقائي (Monkey-patch) بدون تعديل دوال app.js الأصلية
    // ──────────────────────────────────────────────────────
    function hookIntoApp() {
        ensureDataShape();

        // كل مرة تُحدَّث فيها الشاشة المالية → حدّث لوحتنا كمان
        if (typeof window.renderFinances === 'function' && !window.renderFinances.__sessionPatched) {
            const originalRenderFinances = window.renderFinances;
            window.renderFinances = function (...args) {
                const result = originalRenderFinances.apply(this, args);
                renderPanel();
                return result;
            };
            window.renderFinances.__sessionPatched = true;
        }

        // ✅ زرار مستقل خاص بـ"تقرير أداء الحصة" ظاهر بجانب زر التقرير الشهري
        //    لأي طالب "بالحصة" (لا يوجد أي إعادة توجيه تلقائية لزر التقرير
        //    الشهري نفسه — يفضل يفتح تقرير الأداء الشهري العادي زي ما هو دايمًا)
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hookIntoApp);
    } else {
        hookIntoApp();
    }

    return {
        isSessionStudent,
        setStudentSubscriptionMode,
        isGlobalSessionModeActive,
        setGlobalSessionMode,
        getGroupSessionFee,
        setGroupSessionFee,
        getStudentSessionFee,
        getActiveSessionPeriod,
        getAllSessionPeriods,
        startNewSessionPeriod,
        endActiveSessionPeriod,
        promptStartPeriod,
        payForAttendance,
        undoSessionPayment,
        hasAttendancePaid,
        cardBorderColor,
        cardTextColor,
        cardStatusLabel,
        buildSmartCardButtons,
        computeSessionReport,
        buildSubscriptionBoxHtml,
        buildWhatsAppSubStatus,
        openLessonsArchive,
        viewArchivedPeriod,
        backToArchiveList,
        archiveEncryptionSession,
        getAllLessonSessionArchives,
        openLessonSessionsArchive,
        viewLessonSessionArchive,
        backToLessonArchiveList,
        updateArchivedLessonNote,
        toggleArchivedLessonPayment,
        hasLessonPayment,
        openSessionPerformanceReport,
        sendSessionReportWhatsApp,
        renderPanel,
        renderModeIndicator,
        logEncryptionSessionStart,
        getPendingSessionPayment
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionSub;
} else {
    window.SessionSub = SessionSub;
}
