"""Generate synthetic resume fixtures. All people, emails and phones are fictional.

Each person is defined once here and rendered to:
  tests/fixtures/resumes/{id}.txt      resume text as an assistant would transcribe it
  tests/fixtures/resumes/{id}.pdf      original file (for a subset)
  tests/fixtures/resumes/{id}.json     expected CandidateProfile (used by the offline fake LLM)

Run: uv run python scripts/make_fixtures.py
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from fpdf import FPDF

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "resumes"


def role(title, company, start, end, *highlights):
    return {"title": title, "company": company, "start": start, "end": end, "highlights": list(highlights)}


def person(id, name, email, phone, location, title, roles, skills, *, education=(), certs=(), industries=(),
           notice=None, cur_ctc=None, exp_ctc=None, languages=("English",), summary="", pdf=False, style=0):
    return {
        "id": id, "pdf": pdf, "style": style,
        "profile": {
            "name": name, "email": email, "phone": phone, "location": location, "willing_to_relocate": None,
            "preferred_locations": [], "current_title": title,
            "roles": roles, "skills": skills, "education": list(education), "certifications": list(certs),
            "industries": list(industries), "notice_period_days": notice, "current_ctc": cur_ctc,
            "expected_ctc": exp_ctc, "languages": list(languages), "summary": summary,
        },
    }


PEOPLE = [
    # --- backend (JD1: senior backend Python/AWS, Pune or remote, 5-8 yrs)
    person("c01_priya_sharma", "Priya Sharma", "priya.sharma@example.com", "+91 98765 43210", "Pune",
           "Senior Backend Engineer",
           [role("Senior Backend Engineer", "Finlytics", "2022-03", "present",
                 "Led payments migration from monolith to Python microservices on AWS",
                 "Cut p99 latency from 900ms to 180ms with Redis caching",
                 "Designed REST APIs serving 40M requests/day"),
            role("Backend Engineer", "CartNest", "2019-01", "2022-02",
                 "Built order service in Django and PostgreSQL",
                 "Moved batch jobs to AWS Lambda, saving 30% infra cost")],
           ["Python", "Django", "FastAPI", "AWS", "Lambda", "PostgreSQL", "Redis", "Docker", "REST APIs", "Kafka"],
           education=["B.E. Computer Engineering, Pune University, 2018"], industries=["Fintech", "E-commerce"],
           notice=30, cur_ctc="28 LPA", exp_ctc="36 LPA",
           summary="Backend engineer with Python and AWS experience in fintech and e-commerce. Led a payments "
                   "migration to microservices. Based in Pune.", pdf=True, style=0),
    person("c02_arjun_mehta", "Arjun Mehta", "arjun.mehta@example.com", "+91 99887 76655", "Bengaluru",
           "Staff Software Engineer",
           [role("Staff Software Engineer", "Streamly", "2021-06", "present",
                 "Owns event pipeline on Apache Kafka processing 2B events/day",
                 "Python and Go services on AWS EKS"),
            role("Software Engineer", "Tapcab", "2017-07", "2021-05",
                 "Built dispatch APIs in Python/Flask", "Migrated MySQL to Aurora on AWS")],
           ["Python", "Go", "k8s", "AWS", "kafka", "Flask", "MySQL", "gRPC"],
           education=["B.Tech CSE, NIT Trichy, 2017"], industries=["Media", "Mobility"], notice=60,
           summary="Software engineer working on Python and Go services and Kafka event pipelines on AWS. "
                   "Previously built dispatch APIs for a ride-hailing company.", style=1),
    person("c03_neha_kulkarni", "Neha Kulkarni", "neha.k@example.com", "9822012345", "Mumbai",
           "Backend Developer",
           [role("Backend Developer", "InsureNow", "2020-08", "present",
                 "Django REST APIs for policy issuance", "Postgres query tuning, 3x faster reports",
                 "Deployed services on AWS ECS"),
            role("Python Developer", "DataWeave Labs", "2019-06", "2020-07", "ETL scripts in Python and pandas")],
           ["Python", "Django", "DRF", "postgres", "AWS", "Celery", "pandas"],
           education=["M.Sc. Computer Science, Mumbai University, 2019"], industries=["Insurance"],
           notice=15, summary="Python backend developer building Django REST APIs for insurance products on AWS.",
           style=2),
    person("c18_rohan_das", "Rohan Das", "rohan.das@example.com", "+91 90000 11122", "Pune",
           "Junior Python Developer",
           [role("Junior Python Developer", "CodeCraft", "2024-07", "present",
                 "Bug fixes in Flask API", "Wrote unit tests with pytest")],
           ["Python", "Flask", "pytest", "Git"], education=["B.Tech IT, 2024"], notice=0,
           summary="Junior Python developer with one year of experience on a Flask API.", style=0),

    # --- frontend (JD2: React/TypeScript, Mumbai, 3-6 yrs)
    person("c04_ananya_iyer", "Ananya Iyer", "ananya.iyer@example.com", "+91 97000 12345", "Mumbai",
           "Frontend Engineer",
           [role("Frontend Engineer", "ShopKart", "2021-04", "present",
                 "Rebuilt checkout in React and TypeScript, +12% conversion", "Set up Jest and Cypress test suites"),
            role("UI Developer", "PixelWorks", "2020-01", "2021-03", "Built marketing sites in Next.js")],
           ["reactjs", "TypeScript", "Next.js", "Redux", "Jest", "Cypress", "Tailwind"],
           education=["B.E. IT, VJTI, 2019"], industries=["E-commerce"], notice=30,
           summary="Frontend engineer building React and TypeScript applications for e-commerce checkout.",
           pdf=True, style=1),
    person("c05_kabir_shah", "Kabir Shah", "kabir.shah@example.com", "+91 98200 55443", "Mumbai",
           "Senior UI Engineer",
           [role("Senior UI Engineer", "TravelGo", "2019-09", "present",
                 "Led migration from AngularJS to React", "Built design system with 60 components in TypeScript"),
            role("Web Developer", "Brandly", "2018-01", "2019-08", "jQuery and CSS for client sites")],
           ["React", "TS", "AngularJS", "Storybook", "CSS", "GraphQL"],
           education=["B.Sc. IT, 2017"], industries=["Travel"], notice=90,
           summary="UI engineer who led an AngularJS to React migration and built a TypeScript design system.",
           style=2),
    person("c06_meera_joshi", "Meera Joshi", None, "+91 91234 56780", "Thane",
           "React Developer",
           [role("React Developer", "EduSpark", "2022-01", "present",
                 "Student dashboard in React with TypeScript", "Accessibility fixes to WCAG AA")],
           ["React", "TypeScript", "HTML", "CSS", "Vite"],
           education=["B.E. Computer, 2021"], industries=["Edtech"], notice=30,
           summary="React developer building student dashboards in TypeScript for an edtech company.", style=0),

    # --- data science (JD3: data scientist, Python ML/NLP, 3+ yrs)
    person("c07_vikram_rao", "Vikram Rao", "vikram.rao@example.com", "+91 99001 22334", "Hyderabad",
           "Data Scientist",
           [role("Data Scientist", "HealthAI", "2021-02", "present",
                 "Built NLP models for clinical note classification, F1 0.91",
                 "Fine-tuned transformer models with PyTorch and Hugging Face"),
            role("Data Analyst", "RetailIQ", "2019-05", "2021-01", "Demand forecasting in Python and scikit-learn")],
           ["Python", "PyTorch", "NLP", "Hugging Face", "sklearn", "SQL", "pandas"],
           education=["M.Tech Data Science, IIIT Hyderabad, 2019"], industries=["Healthcare", "Retail"],
           notice=60, summary="Data scientist working on NLP models for clinical text with PyTorch.", pdf=True,
           style=1),
    person("c08_sara_khan", "Sara Khan", "sara.khan@example.com", "+91 98111 22233", "Remote",
           "Machine Learning Engineer",
           [role("Machine Learning Engineer", "AdPulse", "2020-03", "present",
                 "Deployed CTR prediction models serving 5k QPS", "Built feature store on Spark and Airflow"),
            role("ML Intern", "AdPulse", "2019-09", "2020-02", "Experimented with gradient boosting models")],
           ["Python", "ML", "TensorFlow", "Spark", "Airflow", "SQL"],
           education=["B.Tech EE, IIT Delhi, 2019"], industries=["Advertising"], notice=30,
           summary="Machine learning engineer deploying CTR prediction models and feature pipelines.", style=2),

    # --- devops (JD4: DevOps/SRE, Kubernetes + Terraform + AWS, 4+ yrs)
    person("c09_aditya_verma", "Aditya Verma", "aditya.verma@example.com", "+91 97654 32109", "Pune",
           "Site Reliability Engineer",
           [role("Site Reliability Engineer", "CloudNine", "2020-11", "present",
                 "Runs 40 EKS clusters with Terraform and Helm", "Cut incident MTTR by 45% with Prometheus alerts"),
            role("Systems Engineer", "Infosys", "2017-06", "2020-10", "Linux administration and Jenkins pipelines")],
           ["Kubernetes", "Terraform", "AWS", "Helm", "Prometheus", "Grafana", "Linux", "Jenkins"],
           education=["B.E. Electronics, 2017"], certs=["CKA", "AWS Solutions Architect Associate"],
           industries=["SaaS"], notice=60, summary="SRE running Kubernetes clusters on AWS with Terraform.",
           style=0),
    person("c10_farah_ali", "Farah Ali", "farah.ali@example.com", "+91 98989 12121", "Bengaluru",
           "DevOps Engineer",
           [role("DevOps Engineer", "PayWave", "2021-01", "present",
                 "Built GitHub Actions CI/CD for 80 services", "Terraform modules for AWS networking"),
            role("Build Engineer", "Mindtree", "2019-01", "2020-12", "Maintained Jenkins and Docker builds")],
           ["k8s", "terraform", "AWS", "Docker", "GitHub Actions", "Python"],
           education=["B.Tech CSE, 2018"], industries=["Fintech"], notice=30,
           summary="DevOps engineer building CI/CD and Terraform infrastructure on AWS.", style=1),

    # --- finance (JD5: finance manager / CA, GST + Tally + IFRS, Mumbai, 5+ yrs)
    person("c11_rajesh_gupta", "Rajesh Gupta", "rajesh.gupta@example.com", "+91 98200 98200", "Mumbai",
           "Finance Manager",
           [role("Finance Manager", "Bharat Textiles", "2019-04", "present",
                 "Monthly close for 3 entities under IFRS", "Managed GST filings and audits"),
            role("Senior Accountant", "Deloitte", "2015-07", "2019-03", "Statutory audits for manufacturing clients")],
           ["GST", "IFRS", "Tally ERP", "SAP FICO", "Advanced Excel", "Financial Modelling"],
           education=["Chartered Accountant, ICAI, 2015", "B.Com, Mumbai University, 2012"],
           certs=["CA"], industries=["Manufacturing", "Audit"], notice=90, cur_ctc="24 LPA",
           summary="Chartered accountant and finance manager handling IFRS close and GST compliance.", pdf=True,
           style=2),
    person("c12_pooja_nair", "Pooja Nair", "pooja.nair@example.com", "+91 90040 50607", "Navi Mumbai",
           "Accounts Lead",
           [role("Accounts Lead", "FreshBasket", "2020-06", "present",
                 "Owns accounts payable and GST returns", "Automated reconciliations in Excel, saving 20 hrs/month"),
            role("Accountant", "SmallBiz Co", "2016", "2020", "Bookkeeping in Tally")],
           ["Tally", "GST", "TDS", "Accounts Payable", "Excel"],
           education=["M.Com, 2016"], industries=["Retail"], notice=30,
           summary="Accounts lead managing payables, GST and TDS for a grocery retailer.", style=0),

    # --- other functions and distractors
    person("c13_divya_menon", "Divya Menon", "divya.menon@example.com", "+91 95555 12345", "Chennai",
           "Talent Acquisition Specialist",
           [role("Talent Acquisition Specialist", "HireRight", "2021-03", "present",
                 "Closed 120 tech hires in 2024", "Ran campus hiring across 15 colleges")],
           ["Recruitment", "Talent Acquisition", "LinkedIn Recruiter", "Workday"], industries=["Staffing"],
           notice=30, summary="Talent acquisition specialist focused on technology hiring.", style=1),
    person("c14_ishaan_bose", "Ishaan Bose", "ishaan.bose@example.com", "+91 93333 44455", "Kolkata",
           "Digital Marketing Manager",
           [role("Digital Marketing Manager", "Glowup Cosmetics", "2020-01", "present",
                 "Managed 2 Cr annual Google Ads budget", "Grew organic traffic 3x through SEO")],
           ["SEO", "Google Ads", "GA4", "HubSpot", "Content Writing"], industries=["Consumer goods"], notice=60,
           summary="Digital marketing manager running paid search and SEO for a cosmetics brand.", style=2),
    person("c15_tanvi_patil", "Tanvi Patil", "tanvi.patil@example.com", "+91 94444 55566", "Pune",
           "QA Automation Engineer",
           [role("QA Automation Engineer", "Finlytics", "2021-07", "present",
                 "Built Selenium and pytest suite of 1,200 tests", "Added API tests to CI/CD pipeline")],
           ["Selenium", "pytest", "Python", "Postman", "Jenkins"], industries=["Fintech"], notice=30,
           summary="QA automation engineer building Selenium and pytest suites for a fintech product.", style=0),
    person("c16_nikhil_reddy", "Nikhil Reddy", "nikhil.reddy@example.com", "+91 96666 77788", "Hyderabad",
           "iOS Developer",
           [role("iOS Developer", "FitTrack", "2020-02", "present",
                 "Shipped SwiftUI rewrite of workout app, 4.8 star rating", "Integrated HealthKit")],
           ["Swift", "SwiftUI", "Objective-C", "Xcode"], industries=["Health"], notice=45,
           summary="iOS developer building fitness apps in Swift and SwiftUI.", style=1),
    person("c17_amit_singh", "Amit Singh", "amit.singh@example.com", "+91 97777 88899", "Delhi",
           "Enterprise Sales Manager",
           [role("Enterprise Sales Manager", "CloudSoft", "2018-05", "present",
                 "Closed 12 Cr ARR in FY24", "Managed 30 enterprise accounts")],
           ["B2B Sales", "Salesforce", "Lead Generation", "CRM"], industries=["SaaS"], notice=90,
           summary="Enterprise SaaS sales manager handling large accounts in north India.", style=2),

    # --- edge cases
    # Overlapping roles (freelance during a full-time job) and a year-only date.
    person("c19_karan_malhotra", "Karan Malhotra", "karan.m@example.com", "+91 98760 00001", "Gurugram",
           "Backend Engineer",
           [role("Backend Engineer", "LogiTrack", "2021-01", "present",
                 "Node.js and TypeScript services on AWS", "Owns shipment tracking APIs"),
            role("Freelance Developer", None, "2020", "2022-06", "Built Django sites for small businesses"),
            role("Software Engineer", "Wipro", "2018-07", "2020-12", "Java Spring Boot services")],
           ["Node.js", "TypeScript", "AWS", "Python", "Django", "Java", "Spring Boot"],
           industries=["Logistics"], notice=30,
           summary="Backend engineer on Node.js and TypeScript services, with earlier Java and Django work.",
           style=0),
    # No dates at all -> years_exp is null.
    person("c20_lata_pillai", "Lata Pillai", "lata.pillai@example.com", None, "Kochi", "Content Writer",
           [role("Content Writer", "Freelance", None, None, "Blog posts for SaaS companies")],
           ["Content Writing", "Copywriting", "SEO"], notice=0,
           summary="Freelance content writer producing blog posts for SaaS companies.", style=1),
]

# Updated resumes for dedup tests: same person, new file. Priya matched by email, Meera (no email) by phone.
UPDATES = [
    ("c01_priya_sharma_v2", "c01_priya_sharma", {
        "current_title": "Engineering Lead",
        "roles_prepend": role("Engineering Lead", "Finlytics", "2025-06", "present",
                              "Leads team of 6 backend engineers", "Owns payments platform roadmap"),
        "end_previous": "2025-05",
    }),
    ("c06_meera_joshi_v2", "c06_meera_joshi", {
        "phone": "091234 56780",
        "skills_add": ["Next.js"],
    }),
]


def render(p: dict, style: int) -> str:
    pr = p
    contact = " | ".join(x for x in [pr["email"], pr["phone"], pr["location"]] if x)
    lines: list[str] = []
    if style == 0:
        lines += [pr["name"].upper(), pr["current_title"], contact, "", "SUMMARY", pr["summary"], "", "EXPERIENCE"]
        for r in pr["roles"]:
            dates = f"{r['start'] or ''} - {r['end'] or ''}".strip(" -")
            lines.append(f"{r['title']}, {r['company'] or 'Self-employed'}   {dates}")
            lines += [f"  - {h}" for h in r["highlights"]]
        lines += ["", "SKILLS", ", ".join(pr["skills"])]
    elif style == 1:
        lines += [f"{pr['name']} — {pr['current_title']}", f"Email: {pr['email'] or '-'}",
                  f"Phone: {pr['phone'] or '-'}", f"Location: {pr['location']}", "",
                  "Professional Experience"]
        for r in pr["roles"]:
            lines.append(f"* {r['company'] or 'Freelance'} ({r['start'] or 'n/a'} to {r['end'] or 'n/a'})")
            lines.append(f"  {r['title']}")
            lines += [f"    · {h}" for h in r["highlights"]]
        lines += ["", "Technical Skills: " + " / ".join(pr["skills"]), "", "About", pr["summary"]]
    else:
        lines += [pr["name"], contact, "", "Profile", pr["summary"], "", "Skills"]
        lines += [f"• {s}" for s in pr["skills"]]
        lines += ["", "Work History"]
        for r in pr["roles"]:
            lines += [f"{r['title']} | {r['company'] or 'Independent'} | {r['start']} – {r['end']}"]
            lines += [f"- {h}" for h in r["highlights"]]
    if pr["education"]:
        lines += ["", "Education"] + pr["education"]
    if pr["certifications"]:
        lines += ["", "Certifications: " + ", ".join(pr["certifications"])]
    if pr["notice_period_days"] is not None:
        n = pr["notice_period_days"]
        lines += ["", "Notice period: " + ("Immediate" if n == 0 else f"{n} days")]
    if pr["current_ctc"]:
        lines += [f"Current CTC: {pr['current_ctc']}"]
    if pr["expected_ctc"]:
        lines += [f"Expected CTC: {pr['expected_ctc']}"]
    lines += ["", "Languages: " + ", ".join(pr["languages"])]
    return "\n".join(lines) + "\n"


def write_pdf(text: str, path: Path) -> None:
    pdf = FPDF()
    pdf.set_creation_date(datetime(2026, 1, 1, tzinfo=timezone.utc))  # stable sha256 across runs
    pdf.add_page()
    pdf.set_font("Helvetica", size=10)
    safe = text.replace("—", "-").replace("–", "-").replace("·", "-").replace("•", "-").replace("…", "...")
    for line in safe.splitlines():
        pdf.multi_cell(0, 5, line or " ", new_x="LMARGIN", new_y="NEXT")
    pdf.output(str(path))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    by_id = {p["id"]: p for p in PEOPLE}
    items = [(p["id"], p["profile"], p["style"], p["pdf"]) for p in PEOPLE]
    for new_id, base_id, change in UPDATES:
        base = by_id[base_id]
        prof = json.loads(json.dumps(base["profile"]))
        if "roles_prepend" in change:
            prof["roles"][0]["end"] = change["end_previous"]
            prof["roles"].insert(0, change["roles_prepend"])
        for key in ("current_title", "phone"):
            if key in change:
                prof[key] = change[key]
        prof["skills"] += change.get("skills_add", [])
        items.append((new_id, prof, base["style"], base["pdf"]))
    for id_, prof, style, pdf in items:
        text = render(prof, style)
        (OUT / f"{id_}.txt").write_text(text, encoding="utf-8")
        # Year-only dates stay "YYYY", as the extraction prompt asks; experience.py interprets them.
        (OUT / f"{id_}.json").write_text(json.dumps(prof, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        if pdf:
            write_pdf(text, OUT / f"{id_}.pdf")
    print(f"wrote {len(items)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
