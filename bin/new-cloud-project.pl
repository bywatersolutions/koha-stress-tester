#!/usr/bin/perl

# new-cloud-project.pl - Create a new Grafana Cloud k6 project and fill it with
# the Koha and Aspen stress-test templates - one command, no web-UI clicking, no
# manual paste. Anyone with 'k6 cloud login' done can stand up a whole project
# of pre-configured tests for a partner or engagement.
#
# Usage:
#   ./bin/new-cloud-project.pl "Partner X"   ( creates "Stress Testing - Partner X" )
#   ./bin/new-cloud-project.pl "Foo" --org 3432454 --dry-run
#   ./bin/new-cloud-project.pl "Foo" --defaults            # accept every default, no prompts
#   ./bin/new-cloud-project.pl "Foo" --set OPAC_URL=https://x --defaults
#
# Interactively prompts for each project variable ( target URLs, load rates,
# class size... ) with an explanation and a default, then bakes the answers into
# that project's tests so they come pre-configured for the server. Press Enter
# to accept a default. --defaults skips the prompts; --set VAR=VALUE pre-seeds a
# variable's default ( repeatable ). Credentials are NOT prompted - they stay on
# the universal Grafana secrets.
#
# Needs 'k6 cloud login --token <token>' once first ( token from the Grafana
# Cloud k6 app ). See docs/GRAFANA_CLOUD.md.
#
# ( VU limits can't be set through the API - that's an admin/plan action in the
# UI - so raise them there if a big run needs more than the project default. )

use Modern::Perl;
use Getopt::Long;
use FindBin;
use HTTP::Tiny;
use JSON::PP;

# The per-project variables prompted for and baked into the new project's tests.
# ( Credentials are deliberately excluded - they come from universal secrets. )
my @CONFIG_VARS = (
    { name => 'OPAC_URL',                    desc => 'Public catalog (OPAC) base URL to test',                              default => 'https://catalog.example.org' },
    { name => 'STAFF_URL',                   desc => 'Staff interface base URL (login-based tests)',                        default => 'https://staff.example.org' },
    { name => 'STAFF_USER',                  desc => 'Superlibrarian username for the login-based tests',                   default => 'bwssupport' },
    { name => 'BASE_URL',                    desc => 'Aspen Discovery base URL for the Aspen tests (leave blank if the library has no Aspen)', default => '' },
    { name => 'OPAC_SEARCHES_PER_HOUR',      desc => 'Peak OPAC catalog searches per hour to sustain',                      default => '5000', num => 1 },
    { name => 'STAFF_TRANSACTIONS_PER_HOUR', desc => 'Staff transactions per hour (Daily Operations test)',                 default => '1000', num => 1 },
    { name => 'PATRON_MODE',                 desc => "Patron catalog shape: 'opac' (direct Koha OPAC) or 'aspen' (Aspen REST API load)", default => 'aspen' },
    { name => 'LIBRARIANS',                  desc => 'Training class size (number of attendees)',                           default => '50', num => 1 },
    { name => 'CATALOG_SEARCH_TERM',         desc => 'A search term with hits in the target catalog',                       default => 'harry potter' },
);

my ( $org_override, $dry_run, $help, $opt_defaults );
my %seed;
GetOptions(
    'org=s'    => \$org_override,
    'set=s%'   => \%seed,
    'defaults' => \$opt_defaults,
    'dry-run'  => \$dry_run,
    'help'     => \$help,
) or die "Try --help\n";

_usage() if $help;

my $name = shift @ARGV;
die "Usage: $0 \"<project name>\" [--org ID] [--dry-run]\n"
    unless defined $name && length $name;
die "Unexpected extra arguments: @ARGV\n" if @ARGV;

# All stress-testing projects share this prefix so they group in the project
# list; don't double-prefix if the user already typed it.
my $NAME_PREFIX = "Stress Testing - ";
$name = $NAME_PREFIX . $name unless $name =~ /^\Q$NAME_PREFIX\E/;

my $token = _k6_token();
my $http  = HTTP::Tiny->new;

# Discover the org ( unless given )
my $org = $org_override;
unless ( defined $org && length $org ) {
    my $res = _api( 'GET', "https://api.k6.io/v3/organizations" );
    die "Error: could not discover organization (HTTP $res->{status})\n" unless $res->{success};
    my $orgs = decode_json( $res->{content} )->{organizations} || [];
    die "Error: no organizations found for this token.\n" unless @$orgs;
    if ( @$orgs > 1 ) {
        say STDERR "Multiple orgs found - pass --org <id>:";
        say STDERR "  $_->{id}  $_->{name}" for @$orgs;
        exit 1;
    }
    $org = $orgs->[0]{id};
}

# Gather this project's settings ( prompts unless --defaults / non-interactive )
my %settings = _prompt_settings();

if ($dry_run) {
    say "\nDRY: would create project '$name' in org $org, then populate the templates with:";
    say "  $_->{name}=$settings{ $_->{name} }" for @CONFIG_VARS;
    exit 0;
}

# Create the project ( POST returns 201 )
my $res = _api( 'POST', "https://api.k6.io/v3/projects",
    { name => $name, organization_id => int($org) } );
die "Error: create project failed HTTP $res->{status}: " . _short( $res->{content} ) . "\n"
    unless $res->{success};
my $pid = decode_json( $res->{content} )->{project}{id}
    or die "Error: project created but no id returned.\n";
say "Created project '$name' (id $pid) in org $org";

# Populate the templates, baking in this project's settings
say "\nPopulating the templates into project $pid ...";
my $sync = "$FindBin::Bin/sync-cloud-tests.pl";
# Only bake vars the user actually gave a value for; a blank ( e.g. no Aspen )
# leaves that test's template default untouched rather than baking an empty URL.
my @set_args = map { ( '--set', "$_->{name}=$settings{ $_->{name} }" ) }
    grep { length $settings{ $_->{name} } } @CONFIG_VARS;
system( $^X, $sync, '--project', $pid, @set_args ) == 0
    or die "Populating templates failed.\n";

say "";
say "=" x 42;
say "Project ready:";
say "  https://bws.grafana.net/a/k6-app/projects/$pid";
say "";
say "The tests are pre-configured for this server. Run each as-is, or";
say "tweak the <<< SET values first.";
say "See docs/GRAFANA_CLOUD.md.";
say "";
say "Secrets ( staff-pass, the ingress token ) are org-wide, so they apply";
say "here automatically. Target servers need RESTBasicAuth enabled.";
say "";
say "Note: the project uses default VU limits - big runs ( e.g. the OPAC peak )";
say "may need them raised in the UI ( project settings / Grafana support ).";
say "=" x 42;

# ------------------------------------------------------------

sub _api {
    my ( $method, $url, $body ) = @_;
    my %opts = ( headers => { Authorization => "Bearer $token" } );
    if ( defined $body ) {
        $opts{headers}{'Content-Type'} = 'application/json';
        $opts{content} = encode_json($body);
    }
    return $http->request( $method, $url, \%opts );
}

# Read one line with basic editing ( left/right arrows, Home/End, backspace,
# Ctrl-A/E/U ) by driving the terminal in raw mode ourselves - a plain <STDIN>
# read is canonical-mode, which passes arrow keys through as "^[[D" etc.
# Falls back to a plain read when stdin/stdout isn't a terminal.
sub _read_line {
    my ( $prompt, $default ) = @_;

    unless ( -t STDIN && -t STDOUT ) {
        print $prompt;
        my $in = <STDIN>;
        return $default unless defined $in;
        chomp $in;
        return length $in ? $in : $default;
    }

    local $| = 1;    # autoflush - we echo by redrawing, so each keystroke must flush now
    my $saved = `stty -g 2>/dev/null`;
    chomp $saved;
    system( "stty", "-icanon", "-echo", "min", "1", "time", "0" );
    my $restore = sub { system( "stty", $saved ) if length $saved };
    local $SIG{INT} = sub { $restore->(); print "\n"; exit 130 };

    my @buf;
    my $pos = 0;
    my $draw = sub {
        print "\r\e[K", $prompt, join( '', @buf );
        my $back = @buf - $pos;
        print "\e[${back}D" if $back > 0;
    };

    my $err;
    eval {
        $draw->();
        my $c;
        while ( sysread( STDIN, $c, 1 ) ) {
            if    ( $c eq "\n" || $c eq "\r" ) { last }
            elsif ( $c eq "\x7f" || $c eq "\x08" ) { splice( @buf, --$pos, 1 ) if $pos > 0 }    # backspace
            elsif ( $c eq "\x03" ) { $restore->(); print "\n"; exit 130 }                       # Ctrl-C
            elsif ( $c eq "\x15" ) { @buf = (); $pos = 0 }                                       # Ctrl-U
            elsif ( $c eq "\x01" ) { $pos = 0 }                                                  # Ctrl-A
            elsif ( $c eq "\x05" ) { $pos = @buf }                                               # Ctrl-E
            elsif ( $c eq "\e" ) {                                                               # escape seq
                sysread( STDIN, my $b, 1 ) or next;
                next unless $b eq '[';
                sysread( STDIN, my $k, 1 ) or next;
                if    ( $k eq 'D' ) { $pos-- if $pos > 0 }                                       # left
                elsif ( $k eq 'C' ) { $pos++ if $pos < @buf }                                    # right
                elsif ( $k eq 'H' ) { $pos = 0 }                                                 # home
                elsif ( $k eq 'F' ) { $pos = @buf }                                              # end
                elsif ( $k eq '3' ) { sysread( STDIN, my $t, 1 ); splice( @buf, $pos, 1 ) if $pos < @buf }  # Del
            }
            elsif ( $c ge ' ' ) { splice( @buf, $pos, 0, $c ); $pos++ }                          # printable
            $draw->();
        }
        1;
    } or $err = $@;

    $restore->();
    print "\n";
    die $err if $err;

    my $val = join( '', @buf );
    return length $val ? $val : $default;
}

# Ask for each config var ( explanation + default ). Returns name => value.
# Non-interactive ( --defaults, dry-run, or no TTY ) just takes the defaults,
# with any --set VAR=VALUE seeds applied.
sub _prompt_settings {
    my %s;
    my $interactive = ( -t STDIN ) && !$opt_defaults && !$dry_run;
    say "\nConfigure this project's tests ( press Enter to accept the default ):" if $interactive;
    for my $v (@CONFIG_VARS) {
        my $name    = $v->{name};
        my $default = defined $seed{$name} ? $seed{$name} : $v->{default};
        my $val     = $default;
        if ($interactive) {
            while (1) {
                say "";
                say "  $name - $v->{desc}";
                $val = _read_line( "    [$default]: ", $default );
                $val =~ s/^\s+|\s+$//g;
                if ( $v->{num} && $val !~ /^-?\d+(?:\.\d+)?$/ ) {
                    say "    ! must be a number";
                    next;
                }
                last;
            }
        }
        $s{$name} = $val;
    }
    return %s;
}

sub _k6_token {
    my $cfg = "$ENV{HOME}/Library/Application Support/k6/config.json";
    die "Error: k6 config not found at $cfg - run 'k6 cloud login --token <token>' first.\n"
        unless -f $cfg;
    open my $fh, '<', $cfg or die "Cannot read $cfg: $!\n";
    local $/;
    my $data = decode_json(<$fh>);
    my $tok = $data->{collectors}{cloud}{token}
        or die "Error: no cloud token in $cfg - run 'k6 cloud login' first.\n";
    return $tok;
}

sub _short { my ($s) = @_; $s //= ''; $s =~ s/\s+/ /g; return substr( $s, 0, 200 ); }

# Print the leading comment block ( the usage header ) and exit.
sub _usage {
    open my $fh, '<', $0 or exit 1;
    my $seen;
    while ( my $l = <$fh> ) {
        next if $l =~ /^#!/;                 # skip shebang
        next if !$seen && $l =~ /^\s*$/;     # skip blank lines before the header
        last unless $l =~ /^#/;              # stop at the first non-comment line
        $seen = 1;
        $l =~ s/^# ?//;
        print $l;
    }
    exit 0;
}
