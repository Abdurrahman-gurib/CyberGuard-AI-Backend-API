-- ============================================================================
-- CyberGuard AI - control catalogue seed (curated, standards-informed)
-- The backend also seeds this catalogue automatically on first boot.
-- ============================================================================

INSERT INTO controls (control_code, description, complexity, framework, reference_code) VALUES
('CG-AC-01', 'Enforce multi-factor authentication for all remote and administrative access.', 'essential',   'NIST CSF 2.0', 'PR.AA'),
('CG-AC-02', 'Review privileged accounts and remove unused access on a defined schedule.',   'essential',   'ISO/IEC 27002:2022', '8.2'),
('CG-AC-03', 'Apply least-privilege role-based access control to business systems.',         'recommended', 'ISO/IEC 27002:2022', '5.15'),
('CG-BK-01', 'Perform daily backups of critical data and store one copy off-site/immutable.','essential',   'NIST CSF 2.0', 'PR.DS'),
('CG-BK-02', 'Test backup restoration on a defined schedule and record the evidence.',       'recommended', 'ISO/IEC 27002:2022', '8.13'),
('CG-VM-01', 'Apply security patches to internet-facing systems within an agreed SLA.',      'essential',   'NIST CSF 2.0', 'ID.RA'),
('CG-VM-02', 'Maintain an asset inventory with product names and versions for advisory matching.', 'recommended', 'NIST CSF 2.0', 'ID.AM'),
('CG-IR-01', 'Maintain and exercise a documented incident response plan.',                   'recommended', 'NIST CSF 2.0', 'RS.MA'),
('CG-IR-02', 'Enable centralised security logging for critical services with retention.',    'advanced',    'ISO/IEC 27002:2022', '8.15'),
('CG-AW-01', 'Deliver phishing and security awareness training to all staff.',               'essential',   'ISO/IEC 27002:2022', '6.3'),
('CG-NT-01', 'Segment networks so critical services are isolated from general user networks.','advanced',   'NIST CSF 2.0', 'PR.IR'),
('CG-CR-01', 'Encrypt sensitive data at rest and in transit using current standards.',       'recommended', 'ISO/IEC 27002:2022', '8.24'),
('CG-SP-01', 'Assess critical suppliers'' security posture and record contractual obligations.', 'recommended', 'NIST CSF 2.0', 'GV.SC'),
('CG-EP-01', 'Deploy endpoint protection with centrally monitored alerts on all devices.',   'essential',   'ISO/IEC 27002:2022', '8.7'),
('CG-REC-01','Reconcile stated policy requirements against operational evidence (e.g. backup reports).', 'recommended', 'NIST CSF 2.0', 'GV.OV')
ON CONFLICT (control_code) DO NOTHING;
