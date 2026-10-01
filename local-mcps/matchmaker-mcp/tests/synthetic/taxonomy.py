"""Vocabulary the synthetic specs draw from: role families and stacks, spelling variants, cities, names."""

# family -> stack -> (titles, core skills: the first two are the stack's identity, optional skills)
FAMILIES: dict[str, dict[str, tuple[list[str], list[str], list[str]]]] = {
    "backend": {
        "python": (["Backend Engineer", "Python Developer", "Software Engineer - Backend"],
                   ["Python", "Django", "FastAPI", "PostgreSQL", "AWS", "REST APIs", "Redis", "Docker"],
                   ["Celery", "Flask", "Apache Kafka", "Microservices"]),
        "java": (["Java Developer", "Backend Engineer", "Software Engineer"],
                 ["Java", "Spring Boot", "Microservices", "MySQL", "Apache Kafka", "AWS", "Docker", "Hibernate"],
                 ["Redis", "Kubernetes", "JUnit", "REST APIs"]),
        "node": (["Node.js Developer", "Backend Engineer", "Full Stack Developer"],
                 ["Node.js", "TypeScript", "Express.js", "MongoDB", "AWS", "GraphQL", "Redis", "Docker"],
                 ["NestJS", "PostgreSQL", "React", "Microservices"]),
        "go": (["Go Developer", "Backend Engineer", "Platform Engineer"],
               ["Go", "gRPC", "Kubernetes", "PostgreSQL", "Microservices", "Docker", "Apache Kafka"],
               ["Redis", "AWS", "Prometheus"]),
    },
    "frontend": {
        "react": (["Frontend Engineer", "React Developer", "UI Engineer"],
                  ["React", "TypeScript", "Next.js", "Redux", "Jest", "CSS", "Tailwind CSS"],
                  ["GraphQL", "Cypress", "Storybook", "Webpack"]),
        "angular": (["Angular Developer", "Frontend Engineer"],
                    ["Angular", "TypeScript", "RxJS", "HTML", "CSS", "Jest"],
                    ["NgRx", "Cypress", "Sass"]),
        "vue": (["Vue.js Developer", "Frontend Developer"],
                ["Vue.js", "JavaScript", "Nuxt.js", "CSS", "HTML"],
                ["TypeScript", "Vite", "Tailwind CSS"]),
    },
    "mobile": {
        "android": (["Android Developer", "Mobile Engineer"],
                    ["Kotlin", "Android", "Jetpack Compose", "Java", "Firebase"],
                    ["Coroutines", "Room", "REST APIs"]),
        "ios": (["iOS Developer", "Mobile Engineer"],
                ["Swift", "iOS", "SwiftUI", "Objective-C", "Xcode"],
                ["Combine", "Core Data", "Firebase"]),
        "react_native": (["React Native Developer", "Mobile Engineer"],
                         ["React Native", "TypeScript", "Redux", "JavaScript", "Firebase"],
                         ["Expo", "Jest", "GraphQL"]),
    },
    "data_science": {
        "ml": (["Data Scientist", "Machine Learning Engineer"],
               ["Python", "Machine Learning", "scikit-learn", "pandas", "SQL", "Deep Learning", "PyTorch"],
               ["TensorFlow", "Natural Language Processing", "Computer Vision", "Apache Spark", "MLflow"]),
        "analytics": (["Data Analyst", "Business Analyst"],
                      ["SQL", "Python", "Tableau", "Power BI", "Microsoft Excel", "pandas"],
                      ["Statistics", "Google Analytics", "Looker"]),
    },
    "data_engineering": {
        "data_eng": (["Data Engineer", "Big Data Engineer"],
                     ["Python", "SQL", "Apache Spark", "Apache Airflow", "Snowflake", "dbt", "AWS"],
                     ["Apache Kafka", "BigQuery", "Databricks", "PySpark"]),
    },
    "devops": {
        "sre": (["DevOps Engineer", "Site Reliability Engineer", "Cloud Engineer"],
                ["Kubernetes", "Terraform", "AWS", "Docker", "CI/CD", "Jenkins", "Linux"],
                ["Helm", "Prometheus", "Grafana", "Ansible", "GitHub Actions"]),
        "azure": (["Azure DevOps Engineer", "Cloud Engineer"],
                  ["Microsoft Azure", "Terraform", "Kubernetes", "Azure DevOps", "Docker", "PowerShell"],
                  ["Ansible", "Linux", "Bicep"]),
    },
    "ai_engineer": {
        "ai_aws": (["AI Engineer", "Generative AI Engineer", "ML Engineer - GenAI"],
                   ["Python", "Generative AI", "Large Language Models", "Amazon Bedrock", "RAG", "AWS Lambda",
                    "LangChain", "Vector Databases"],
                   ["Prompt Engineering", "DynamoDB", "Step Functions", "FastAPI"]),
        "ai_microsoft": (["AI Engineer", "Copilot Developer", "Power Platform Developer"],
                         ["Microsoft Copilot Studio", "Power Automate", "Generative AI", "Power Platform",
                          "Azure OpenAI", "Dataverse"],
                         ["Python", "SharePoint", "Microsoft Graph", "Prompt Engineering"]),
        "ai_agents": (["AI Agent Engineer", "Founding Engineer", "LLM Engineer"],
                      ["Python", "Large Language Models", "AI Agents", "TypeScript", "RAG", "LangChain"],
                      ["MCP", "Vector Databases", "Next.js", "Prompt Engineering"]),
    },
    "qa": {
        "automation": (["QA Automation Engineer", "SDET", "Test Engineer"],
                       ["Selenium", "Test Automation", "Java", "TestNG", "Postman", "Jenkins"],
                       ["Cypress", "Playwright", "pytest", "JUnit"]),
    },
    "finance": {
        "accounts": (["Accountant", "Finance Executive", "Accounts Manager"],
                     ["Tally", "GST", "TDS", "Accounts Payable", "Microsoft Excel"],
                     ["SAP FICO", "IFRS", "Financial Modeling"]),
        "fpa": (["Financial Analyst", "FP&A Manager"],
                ["Financial Modeling", "FP&A", "Microsoft Excel", "IFRS", "SAP FICO"],
                ["Power BI", "Budgeting", "Variance Analysis"]),
    },
    "hr": {
        "recruiting": (["Talent Acquisition Specialist", "Recruiter", "HR Executive"],
                       ["Recruitment", "Talent Acquisition", "LinkedIn Recruiter", "Workday"],
                       ["HRIS", "Payroll", "Onboarding"]),
    },
    "marketing": {
        "digital": (["Digital Marketing Manager", "SEO Specialist", "Performance Marketer"],
                    ["SEO", "Google Ads", "Google Analytics", "Social Media Marketing", "HubSpot"],
                    ["Content Writing", "SEM", "Email Marketing"]),
    },
    "sales": {
        "b2b": (["Business Development Manager", "Account Executive", "Sales Manager"],
                ["B2B Sales", "Salesforce", "Lead Generation", "CRM"],
                ["HubSpot", "Negotiation", "Key Account Management"]),
    },
    "design": {
        "product_design": (["Product Designer", "UI/UX Designer"],
                           ["Figma", "UI/UX Design", "Prototyping", "User Research"],
                           ["Adobe XD", "Adobe Photoshop", "Design Systems"]),
    },
}

# Candidate share per family (sums to 1).
FAMILY_WEIGHTS = {
    "backend": 0.20, "frontend": 0.11, "mobile": 0.06, "data_science": 0.09, "data_engineering": 0.05,
    "devops": 0.07, "ai_engineer": 0.08, "qa": 0.06, "finance": 0.07, "hr": 0.05, "marketing": 0.06,
    "sales": 0.05, "design": 0.05,
}

# Specific skills that imply an umbrella the job may ask for. Ground truth only; the system has its own table.
IMPLIES = {
    "AWS Lambda": ["AWS"], "Amazon Bedrock": ["AWS"], "DynamoDB": ["AWS"], "Step Functions": ["AWS"],
    "Django": ["Python"], "FastAPI": ["Python"], "Flask": ["Python"], "Spring Boot": ["Java"],
    "Next.js": ["React"], "Express.js": ["Node.js"], "NestJS": ["Node.js"], "PySpark": ["Apache Spark", "Python"],
}

# How a canonical skill is sometimes written on a resume. The system has to map these back.
VARIANTS = {
    "Kubernetes": ["k8s", "K8s"], "Node.js": ["NodeJS", "Node JS"], "PostgreSQL": ["Postgres", "postgresql"],
    "JavaScript": ["JS", "Javascript"], "TypeScript": ["TS"], "Python": ["Python 3", "Python3"],
    "React": ["ReactJS", "React.js"], "Machine Learning": ["ML"], "Large Language Models": ["LLMs"],
    "Generative AI": ["GenAI", "Gen AI"], "Amazon Bedrock": ["AWS Bedrock"], "Apache Kafka": ["Kafka"],
    "Apache Spark": ["Spark"], "Apache Airflow": ["Airflow"], "CI/CD": ["CICD"], "Microsoft Excel": ["Advanced Excel",
    "MS Excel"], "Google Analytics": ["GA4"], "Spring Boot": ["SpringBoot"], "Go": ["Golang"],
    "scikit-learn": ["sklearn"], "Financial Modeling": ["Financial Modelling"], "Tally": ["Tally ERP 9", "Tally Prime"],
    "Natural Language Processing": ["NLP"], "Vue.js": ["VueJS", "Vue"], "Next.js": ["NextJS"],
    "Express.js": ["ExpressJS", "Express"], "Microsoft Azure": ["Azure"], "Deep Learning": ["DL"],
    "Power BI": ["PowerBI"], "Salesforce": ["SFDC"], "UI/UX Design": ["UI/UX", "UX/UI Design"],
    "RAG": ["Retrieval-Augmented Generation"], "Microsoft Copilot Studio": ["Copilot Studio"],
    "Azure OpenAI": ["Azure OpenAI Service"], "Test Automation": ["Automation Testing"],
}
# AWS holders sometimes list only services, never the word "AWS".
AWS_SERVICES = ["EC2", "S3", "Lambda", "RDS", "CloudWatch", "SQS"]

GENERIC = ["Git", "Jira", "Agile", "Linux", "Confluence"]

# city key -> ways people write it. Keys follow recruiter_mcp.locations.
CITIES: dict[str, tuple[float, list[str]]] = {
    "bengaluru": (0.24, ["Bengaluru", "Bangalore", "Whitefield, Bangalore", "Koramangala, Bengaluru, India"]),
    "pune": (0.12, ["Pune", "Pune, Maharashtra", "Hinjewadi, Pune", "Pimpri-Chinchwad"]),
    "mumbai": (0.12, ["Mumbai", "Andheri East, Mumbai", "Thane West", "Navi Mumbai, Maharashtra"]),
    "delhi": (0.13, ["New Delhi", "Gurgaon", "Noida, Uttar Pradesh", "Gurugram, Haryana", "Delhi NCR"]),
    "hyderabad": (0.12, ["Hyderabad", "Hyderabad, Telangana", "Secunderabad"]),
    "chennai": (0.08, ["Chennai", "Chennai, Tamil Nadu"]),
    "kolkata": (0.04, ["Kolkata", "Kolkata, West Bengal"]),
    "ahmedabad": (0.04, ["Ahmedabad", "Ahmedabad, Gujarat"]),
    "jaipur": (0.02, ["Jaipur, Rajasthan"]),
    "kochi": (0.02, ["Kochi, Kerala", "Cochin"]),
    "indore": (0.02, ["Indore, Madhya Pradesh"]),
    "remote": (0.05, ["Remote", "Remote (India)"]),
}
# Metro membership for ground truth: a job in any of these accepts all of them.
METRO = {"mumbai": "mumbai", "thane": "mumbai", "navi mumbai": "mumbai", "delhi": "delhi", "gurugram": "delhi",
         "noida": "delhi"}

FIRST_NAMES = [
    "Aarav", "Aditi", "Akash", "Ananya", "Anil", "Anjali", "Arjun", "Ayesha", "Bhavna", "Chirag", "Deepa", "Dev",
    "Divya", "Farhan", "Gauri", "Harsh", "Ishita", "Jatin", "Kavya", "Kiran", "Lakshmi", "Manish", "Meghna", "Mohit",
    "Naina", "Neel", "Nikita", "Omkar", "Pallavi", "Pranav", "Priyanka", "Rahul", "Ritika", "Rohit", "Sahil",
    "Sanjana", "Shreya", "Siddharth", "Sneha", "Suresh", "Tanya", "Tarun", "Uday", "Vaishnavi", "Varun", "Vidya",
    "Yash", "Zoya", "Imran", "Joseph", "Fatima", "Gurpreet", "Harpreet", "Thomas", "Sana", "Kunal", "Rekha",
]
LAST_NAMES = [
    "Agarwal", "Bansal", "Bhat", "Chatterjee", "Desai", "Dutta", "Fernandes", "Ghosh", "Gupta", "Hegde", "Iyer",
    "Jain", "Joshi", "Kapoor", "Khan", "Kulkarni", "Kumar", "Mehta", "Menon", "Mishra", "Nair", "Naidu", "Pandey",
    "Patel", "Pillai", "Rao", "Reddy", "Saxena", "Shah", "Sharma", "Singh", "Sinha", "Srinivasan", "Thakur",
    "Varghese", "Verma", "Yadav", "Qureshi", "D'Souza", "Gill", "Chauhan", "Banerjee",
]
COMPANIES = [
    "Finlytics", "CartNest", "Zentrix Labs", "Orbit Health", "Paystack India", "NimbusSoft", "Quanta Retail",
    "Bluefin Logistics", "Kite Learning", "Vertex Analytics", "Helio Energy", "UrbanPantry", "Medisure",
    "Trellis Systems", "Saffron Bank", "GreenGrid", "Pixelwave Studios", "Ledgerly", "Covalent Infotech",
    "Tata Consultancy Services", "Infosys", "Wipro", "Accenture", "Cognizant", "HCLTech", "Capgemini",
    "Freshworks", "Zoho", "Swiggy", "Razorpay", "Meesho", "PhonePe", "Dream11", "Nykaa", "Ola",
]
EDUCATION = [
    "B.Tech, Computer Science, VIT Vellore", "B.E., Information Technology, Pune University",
    "B.Tech, Electronics, NIT Trichy", "MCA, Symbiosis", "B.Sc Computer Science, St. Xavier's College",
    "B.Com, Narsee Monjee College", "MBA (Finance), NMIMS", "MBA (Marketing), IIM Indore",
    "M.Tech, Data Science, IIIT Hyderabad", "B.Des, NID Ahmedabad", "BBA, Christ University",
    "B.Tech, Computer Engineering, MPSTME NMIMS", "CA, ICAI",
]
